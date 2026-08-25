// Courier registry. Phase 1 covers sources 1 through 13 (x12_carc_rarc, source 20, is
// blocked on X12 licensing; docs/DECISIONS.md D10). Phase 4 adds mac_sites,
// payer_policies, and the upload and import pipelines.
import type { Courier } from '../courier.js';
import { cmsNcciPtpCourier } from './cms-ncci-ptp.js';
import { cmsNcciMueCourier } from './cms-ncci-mue.js';
import { cmsNcciManualCourier } from './cms-ncci-manual.js';
import { cmsHcpcsCourier } from './cms-hcpcs.js';
import { cmsMpfsCourier } from './cms-mpfs.js';
import { cmsIomCourier } from './cms-iom.js';
import { cmsIcd10cmCourier } from './cms-icd10cm.js';
import { cmsTelehealthCourier } from './cms-telehealth.js';
import { cmsTherapyCourier } from './cms-therapy.js';
import { oigWorkplanCourier } from './oig-workplan.js';
import { fedregCourier } from './fedreg.js';
import { cmsMlnCourier } from './cms-mln.js';

export const ALL_COURIERS: Courier[] = [
  cmsNcciPtpCourier,
  cmsNcciMueCourier,
  cmsNcciManualCourier,
  cmsHcpcsCourier,
  cmsMpfsCourier,
  cmsIomCourier,
  cmsIcd10cmCourier,
  cmsTelehealthCourier,
  cmsTherapyCourier,
  oigWorkplanCourier,
  fedregCourier,
  cmsMlnCourier,
];
