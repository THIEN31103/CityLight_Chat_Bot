// Service region (S62, shared/region.ts): SERVICE_REGION unset = no limit (production). With a region every
// cabinet / pole position written through the API must lie inside it, and the area tree is the region's ward
// list (seeded by packages/db/src/seed-region.ts), so area create / rename / delete are refused.
import { inRegion, type GeoPoint } from '@citylight/shared';
import { loadServiceRegion } from '@citylight/shared/region-node';
import { ApiError } from './errors';

export const REGION = loadServiceRegion();

export function assertInRegion(p: GeoPoint) {
  if (REGION && !inRegion(REGION, p))
    throw new ApiError(422, 'outside_region', `Vị trí ${p.lat}, ${p.lng} nằm ngoài phạm vi hoạt động (${REGION.name})`, { region: REGION.name });
}

export function assertAreasEditable() {
  if (REGION) throw new ApiError(409, 'areas_locked', `Danh sách khu vực theo địa giới ${REGION.name}, không sửa trên web`, { region: REGION.name });
}
