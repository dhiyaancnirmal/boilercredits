/** Value Purdue's school search uses for non-US institutions. */
export const PURDUE_INTL_SCHOOL_BUCKET = "Outside US";

export type PublicSchoolLocation = "US" | "International";

export function toPurdueSchoolLocationParam(publicLoc: PublicSchoolLocation): string {
  return publicLoc === "International" ? PURDUE_INTL_SCHOOL_BUCKET : "US";
}

/**
 * School-list APIs only use US vs international bucket; map public/legacy names to Purdue's.
 * Other values pass through for reverse-catalog refresh jobs.
 */
export function coercePayloadLocationToPurdue(loc: string): string {
  if (loc === "International" || loc === PURDUE_INTL_SCHOOL_BUCKET) return PURDUE_INTL_SCHOOL_BUCKET;
  if (loc === "US") return "US";
  return loc;
}
