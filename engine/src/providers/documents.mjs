import { doctorDocuments } from './doctor.mjs';

export async function documentCapabilities(config) {
  return doctorDocuments(config);
}
