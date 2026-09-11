"""Read-only OOXML semantic extraction. JSON stdin/stdout; no document commands executed."""
import hashlib
import json
import mimetypes
import posixpath
import struct
import sys
from pathlib import Path
from zipfile import ZipFile
from lxml import etree

NS = {
    'a': 'http://schemas.openxmlformats.org/drawingml/2006/main',
    'p': 'http://schemas.openxmlformats.org/presentationml/2006/main',
    'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
    'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
    'wp': 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
    'm': 'http://schemas.openxmlformats.org/officeDocument/2006/math',
    'c': 'http://schemas.openxmlformats.org/drawingml/2006/chart',
    'v': 'urn:schemas-microsoft-com:vml',
}
PARSER = etree.XMLParser(resolve_entities=False, no_network=True)

def xml(data):
    return etree.fromstring(data, parser=PARSER)

def query(element, expression):
    return element.xpath(expression, namespaces=NS)

def local(element):
    return etree.QName(element).localname

def text(element):
    return ''.join(query(element, './/w:t/text() | .//a:t/text() | .//m:t/text()'))

class InputError(Exception):
    def __init__(self, code, detail):
        super().__init__(detail)
        self.code = code


def inspect(path, kind):
    if kind in ('docx', 'pptx'):
        with ZipFile(path) as z:
            # Limit inflated input before reading arbitrary package parts.
            if sum(i.file_size for i in z.infolist()) > 512 * 1024 * 1024:
                raise InputError('INPUT_TOO_LARGE', 'Uncompressed OOXML exceeds 512 MiB')
            target = 'word/document.xml' if kind == 'docx' else 'ppt/presentation.xml'
            if target not in z.namelist() or '[Content_Types].xml' not in z.namelist():
                raise InputError('DOCUMENT_SIGNATURE_MISMATCH', f'ZIP package is not {kind}')
            root = xml(z.read(target))
            expected = f"{{{NS['w']}}}document" if kind == 'docx' else f"{{{NS['p']}}}presentation"
            if root.tag != expected:
                raise InputError('DOCUMENT_SIGNATURE_MISMATCH', f'Unsupported {kind} namespace/root')
            types = xml(z.read('[Content_Types].xml'))
            content = [n.get('ContentType', '') for n in types if n.get('PartName') == '/' + target]
            expected_type = 'application/vnd.openxmlformats-officedocument.' + ('wordprocessingml.document.main+xml' if kind == 'docx' else 'presentationml.presentation.main+xml')
            if content != [expected_type]:
                raise InputError('DOCUMENT_SIGNATURE_MISMATCH', 'OOXML content type does not match extension (macro-enabled/encrypted formats are not supported)')
    else:
        # Read the actual CFB directory stream through the FAT, not byte-string searching.
        data = Path(path).read_bytes()
        sector_size = 1 << struct.unpack_from('<H', data, 30)[0]
        if sector_size not in (512, 4096):
            raise InputError('DOCUMENT_SIGNATURE_MISMATCH', 'Invalid CFB sector size')
        def sector(sid):
            start = (sid + 1) * sector_size
            if start < sector_size or start + sector_size > len(data):
                raise InputError('DOCUMENT_SIGNATURE_MISMATCH', 'Invalid CFB sector reference')
            return data[start:start + sector_size]
        fat_ids = list(struct.unpack_from('<109I', data, 76))
        next_difat, count = struct.unpack_from('<II', data, 68)
        seen = set()
        for _ in range(count):
            if next_difat in seen:
                raise InputError('DOCUMENT_SIGNATURE_MISMATCH', 'Cyclic CFB DIFAT')
            seen.add(next_difat)
            values = struct.unpack('<' + 'I' * (sector_size // 4), sector(next_difat))
            fat_ids.extend(values[:-1]); next_difat = values[-1]
        fat = []
        for sid in fat_ids:
            if sid < 0xfffffffa:
                fat.extend(struct.unpack('<' + 'I' * (sector_size // 4), sector(sid)))
        sid = struct.unpack_from('<I', data, 48)[0]
        directory = bytearray(); seen = set()
        while sid < 0xfffffffa:
            if sid in seen or sid >= len(fat):
                raise InputError('DOCUMENT_SIGNATURE_MISMATCH', 'Invalid CFB directory chain')
            seen.add(sid); directory.extend(sector(sid)); sid = fat[sid]
        names = []
        for i in range(0, len(directory), 128):
            entry = directory[i:i + 128]
            size = struct.unpack_from('<H', entry, 64)[0]
            if entry[66] == 2 and 2 <= size <= 64:
                names.append(entry[:size - 2].decode('utf-16-le'))
        required = 'WordDocument' if kind == 'doc' else 'PowerPoint Document'
        if required not in names:
            raise InputError('DOCUMENT_SIGNATURE_MISMATCH', f'CFB file does not contain {required} stream')
    return {'valid': True}


class Extractor:
    def __init__(self, path, output):
        self.z = ZipFile(path)
        self.output = Path(output); self.output.mkdir(parents=True, exist_ok=True)
        self.nodes = []; self.assets = []; self.warnings = []; self.media = {}

    def warn(self, code, locator, detail):
        self.warnings.append({'code': code, 'locator': locator, 'detail': detail})

    def node(self, kind, value, locator, parent=None, rect=None):
        node = {'kind': kind, 'text': value, 'locator': locator, 'assetNames': []}
        if parent: node['parentLocator'] = parent
        if rect: node['rect'] = rect
        self.nodes.append(node)
        return node

    def part(self, name):
        return xml(self.z.read(name))

    def rels(self, part):
        path = posixpath.join(posixpath.dirname(part), '_rels', posixpath.basename(part) + '.rels')
        if path not in self.z.namelist(): return {}
        return {r.get('Id'): {'target': r.get('Target'), 'type': r.get('Type'), 'external': r.get('TargetMode') == 'External'} for r in self.part(path)}

    def target(self, part, rel):
        target = posixpath.normpath(posixpath.join(posixpath.dirname(part), rel['target']))
        if target.startswith('/'):
            target = target.lstrip('/')
        if target.startswith('../') or target not in self.z.namelist():
            raise InputError('DOCUMENT_EXTRACTION_FAILED', f'Invalid package relationship: {part} -> {target}')
        return target

    def media_asset(self, part, rid, locator):
        rel = self.rels(part).get(rid)
        if not rel:
            self.warn('IMAGE_EXTRACTION_FAILED', locator, f'Missing relationship {rid} in {part}'); return None
        if rel['external']:
            self.warn('IMAGE_EXTRACTION_FAILED', locator, f'External document media not fetched: {rel["target"]}. Original and rendered page retain available evidence.'); return None
        target = self.target(part, rel)
        if target not in self.media:
            data = self.z.read(target)
            name = hashlib.sha256(target.encode()).hexdigest()[:16] + '-' + posixpath.basename(target)
            (self.output/name).write_bytes(data)
            self.assets.append({'name': name, 'mediaType': mimetypes.guess_type(target)[0] or 'application/octet-stream', 'locator': target})
            self.media[target] = name
        return self.media[target]

    def images(self, element, part, locator, parent, rect=None):
        for index, blip in enumerate(query(element, './/a:blip | .//v:imagedata')):
            image_locator = f'{locator}/image:{index + 1}'
            node = self.node('image', blip.get('title', ''), image_locator, parent, rect)
            rid = blip.get(f"{{{NS['r']}}}embed") or blip.get(f"{{{NS['r']}}}link") or blip.get(f"{{{NS['r']}}}id")
            asset = self.media_asset(part, rid, image_locator)
            if asset: node['assetNames'].append(asset)

    def ppt(self):
        presentation = self.part('ppt/presentation.xml')
        dims = query(presentation, './p:sldSz')[0]
        width, height = float(dims.get('cx')), float(dims.get('cy'))
        rels = self.rels('ppt/presentation.xml')
        for index, slide_id in enumerate(query(presentation, './p:sldIdLst/p:sldId'), 1):
            part = self.target('ppt/presentation.xml', rels[slide_id.get(f"{{{NS['r']}}}id")])
            root = self.part(part); page = f'slide:{index}'
            self.node('page', f'Slide {index}', page)
            self.warn('UNSUPPORTED_APPEARANCE', page, 'Slide/master/layout styling, background, effects and geometry are retained in the original and rendered page; semantic nodes are not editable appearance reconstructions.')

            def shapes(tree, parent, transform=(1, 1, 0, 0)):
                for shape in tree:
                    typ = local(shape)
                    if typ in ('nvGrpSpPr', 'grpSpPr', 'extLst'): continue
                    ids = query(shape, './p:nvSpPr/p:cNvPr | ./p:nvPicPr/p:cNvPr | ./p:nvGraphicFramePr/p:cNvPr | ./p:nvGrpSpPr/p:cNvPr | ./p:nvCxnSpPr/p:cNvPr')
                    native = ids[0].get('id') if ids else str(list(tree).index(shape))
                    locator = f'{parent}/object:{native}'
                    xfs = query(shape, './p:spPr/a:xfrm | ./p:grpSpPr/a:xfrm | ./p:xfrm')
                    rect = None; child_transform = transform
                    if xfs:
                        xf = xfs[0]; off = query(xf, './a:off'); ext = query(xf, './a:ext')
                        if off and ext:
                            x, y = float(off[0].get('x')), float(off[0].get('y'))
                            cx, cy = float(ext[0].get('cx')), float(ext[0].get('cy'))
                            sx, sy, tx, ty = transform
                            # Keep normalized page bounds for intentionally off-page objects.
                            l, t = max(0, min(1, (x*sx+tx)/width)), max(0, min(1, (y*sy+ty)/height))
                            r, b = max(l, min(1, ((x+cx)*sx+tx)/width)), max(t, min(1, ((y+cy)*sy+ty)/height))
                            rect = [l, t, r-l, b-t]
                            if typ == 'grpSp':
                                ch_off = query(xf, './a:chOff'); ch_ext = query(xf, './a:chExt')
                                if ch_off and ch_ext:
                                    csx = cx / float(ch_ext[0].get('cx') or 1); csy = cy / float(ch_ext[0].get('cy') or 1)
                                    child_transform = (sx*csx, sy*csy, tx+sx*(x-float(ch_off[0].get('x'))*csx), ty+sy*(y-float(ch_off[0].get('y'))*csy))
                            if xf.get('rot') or xf.get('flipH') or xf.get('flipV'):
                                self.warn('UNSUPPORTED_APPEARANCE', locator, 'Rotation/flip retained in raster; rect is the unrotated object box.')
                    node = self.node('paragraph', '', locator, parent, rect)
                    if typ == 'grpSp':
                        self.warn('UNSUPPORTED_APPEARANCE', locator, 'Grouped object appearance uses static page fallback; child content and normalized group transforms are extracted.')
                        shapes(shape, locator, child_transform)
                        continue
                    tables = query(shape, './/a:tbl')
                    if tables:
                        node['kind'] = 'table'
                        node['text'] = '\n'.join('\t'.join(text(cell) for cell in query(row, './a:tc')) for row in query(tables[0], './a:tr'))
                    else:
                        node['text'] = '\n'.join(text(p) for p in query(shape, './p:txBody/a:p'))
                    self.images(shape, part, locator, locator, rect)
                    for chart in query(shape, './/c:chart'):
                        rel = self.rels(part).get(chart.get(f"{{{NS['r']}}}id"))
                        if rel and not rel['external']:
                            chart_part = self.target(part, rel)
                            chart_root = self.part(chart_part)
                            self.node('table', '\n'.join(query(chart_root, './/c:v/text() | .//a:t/text()')), locator + '/chart-data', locator, rect)
                        self.warn('UNSUPPORTED_CHART', locator, 'Chart cached labels/values extracted; visual formatting, formulas and embedded workbook semantics require the original/rendered page.')
                    if query(shape, './/a:alpha | .//a:alphaModFix | .//a:alphaOff | .//a:alphaMod'):
                        self.warn('UNSUPPORTED_APPEARANCE', locator, 'Transparency is preserved in the original/rendered page, not reconstructed as a semantic object.')
                    if typ not in ('sp', 'pic', 'graphicFrame', 'cxnSp') or query(shape, './/a:graphicData[not(a:tbl) and not(c:chart)] | .//p:oleObj | .//a:videoFile | .//a:audioFile'):
                        self.warn('UNSUPPORTED_OBJECT', locator, f'{typ} or embedded graphic/media content retained only in original and static page fallback.')
            trees = query(root, './p:cSld/p:spTree')
            if trees: shapes(trees[0], page)
            for rid, rel in self.rels(part).items():
                if rel['type'].endswith('/notesSlide') and not rel['external']:
                    notes_part = self.target(part, rel)
                    for j, p in enumerate(query(self.part(notes_part), './/p:sp[p:nvSpPr/p:nvPr/p:ph[@type="body"]]/p:txBody/a:p'), 1):
                        self.node('paragraph', text(p), f'{page}/notes:{j}', page)
            if query(root, './p:timing | ./p:transition'):
                self.warn('UNSUPPORTED_ANIMATION', page, 'Native timing/transition metadata exists in the original; static page extraction does not preserve animation playback.')

    def word(self):
        def visit(element, part, locator, parent=None):
            typ = local(element)
            current = parent
            if typ == 'p':
                # Paragraph identity is independent of PDF pagination.
                para_id = element.get('{http://schemas.microsoft.com/office/word/2010/wordml}paraId')
                if para_id: locator += f'@paraId:{para_id}'
                styles = query(element, './w:pPr/w:pStyle/@w:val')
                kind = 'heading' if styles and (styles[0].startswith('Heading') or styles[0] == 'Title') else 'paragraph'
                self.node(kind, text(element), locator, parent); current = locator
                self.images(element, part, locator, current)
                for j, math in enumerate(query(element, './/m:oMath[not(ancestor::m:oMath)]'), 1):
                    self.node('math', text(math), f'{locator}/math:{j}', current)
                    self.warn('UNSUPPORTED_MATH_LAYOUT', f'{locator}/math:{j}', 'OMML text extracted; equation layout/operators remain in original/rendered page.')
                for j, note in enumerate(query(element, './/w:footnoteReference | .//w:endnoteReference'), 1):
                    self.node('link', f'{local(note)}:{note.get("{"+NS["w"]+"}id")}', f'{locator}/note-reference:{j}', current)
                for j, link in enumerate(query(element, './/w:hyperlink'), 1):
                    rel = self.rels(part).get(link.get(f"{{{NS['r']}}}id"))
                    target = rel['target'] if rel else link.get(f"{{{NS['w']}}}anchor", '')
                    self.node('link', text(link) + ' ' + target, f'{locator}/link:{j}', current)
                if query(element, './/wp:anchor'):
                    self.warn('UNSUPPORTED_LAYOUT', locator, 'Floating image anchor/wrapping is retained in original/rendered page; logical image has no invented page coordinates.')
                if query(element, './/w:object | .//w:pict | .//w:fldChar | .//w:instrText | .//w:del | .//w:ins | .//w:txbxContent'):
                    self.warn('UNSUPPORTED_OBJECT', locator, 'Embedded/VML/field/revision/text-box content uses original and rendered-page evidence; visible text/images are extracted where represented in XML.')
                return
            if typ == 'tbl':
                rows = query(element, './w:tr')
                self.node('table', '\n'.join('\t'.join(text(c) for c in query(r, './w:tc')) for r in rows), locator, parent)
                current = locator
            if typ == 'sectPr':
                cols = query(element, './w:cols')
                if cols and (int(cols[0].get(f"{{{NS['w']}}}num", '1')) > 1 or len(cols[0]) > 1):
                    self.warn('UNSUPPORTED_LAYOUT', locator, 'Multiple columns are retained by page rendering; paragraph IDs represent logical document order, not page/column layout.')
            if typ in ('altChunk', 'sdt', 'customXml'):
                self.warn('UNSUPPORTED_OBJECT', locator, f'{typ} structure retained in original/rendered pages; contained XML text is traversed when present.')
            for i, child in enumerate(element):
                # Properties do not contain narrative content; sectPr is needed for explicit layout warnings.
                if local(child) in ('pPr', 'rPr', 'tblPr', 'tcPr', 'trPr'): continue
                visit(child, part, f'{locator}/{local(child)}:{i + 1}', current)

        visit(self.part('word/document.xml'), 'word/document.xml', 'word/document.xml')
        for part in self.z.namelist():
            if part.startswith('word/') and (posixpath.basename(part).startswith(('header', 'footer')) or part in ('word/footnotes.xml', 'word/endnotes.xml')) and part.endswith('.xml'):
                visit(self.part(part), part, part)
        self.warn('UNSUPPORTED_LAYOUT', 'word/document.xml', 'Pagination, section layout, styling and field evaluation are separate renderer evidence. Semantic nodes are logical XML identities and have no guessed page coordinates.')

    def finish(self):
        # Preserve package media even when unsupported geometry never references it semantically.
        for part in self.z.namelist():
            if ('/media/' in part or '/embeddings/' in part) and not part.endswith('/') and part not in self.media:
                data = self.z.read(part); name = hashlib.sha256(part.encode()).hexdigest()[:16] + '-' + posixpath.basename(part)
                (self.output/name).write_bytes(data)
                self.assets.append({'name': name, 'mediaType': mimetypes.guess_type(part)[0] or 'application/octet-stream', 'locator': part})
                self.warn('UNMAPPED_PACKAGE_ASSET', part, 'Package asset copied intact; no supported semantic object mapping. Original and static page fallback retained.')
        self.z.close()
        return {'nodes': self.nodes, 'assets': self.assets, 'warnings': self.warnings}


def main(request):
    operation = request.get('operation')
    if operation == 'pdf-pages':
        from pypdf import PdfReader
        return {'count': len(PdfReader(request['path']).pages)}
    inspect(request['path'], request['kind'])
    if operation == 'inspect': return {'valid': True}
    if operation != 'extract': raise InputError('INVALID_REQUEST', 'Unknown document operation')
    extractor = Extractor(request['path'], request['output'])
    if request['kind'] == 'pptx': extractor.ppt()
    elif request['kind'] == 'docx': extractor.word()
    else: raise InputError('INVALID_REQUEST', 'Convert legacy documents before semantic extraction')
    return extractor.finish()

if __name__ == '__main__':
    try:
        print(json.dumps(main(json.load(sys.stdin)), ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'error': {'code': getattr(error, 'code', 'DOCUMENT_EXTRACTION_FAILED'), 'detail': str(error)}}, ensure_ascii=False))
