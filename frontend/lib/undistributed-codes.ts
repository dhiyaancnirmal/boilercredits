/**
 * Purdue transfer codes with an X in the second position of the course number.
 * Wording aligned with https://www.purdue.edu/registrar/currentStudents/Transfer%20Credit.html
 */

export type UndistributedKind = "ucc" | "general";

export type UndistributedMeaning = {
  kind: UndistributedKind;
  /** Short line shown as the popover title */
  headline: string;
  /** One or two plain sentences */
  detail: string;
};

/** Suffix after the first digit and X (e.g. HUM in 1XHUM). */
const SUFFIXES: Record<string, UndistributedMeaning> = {
  // University Core, single foundational outcome (registrar table)
  BSS: {
    kind: "ucc",
    headline: "Behavioral and social sciences",
    detail:
      "Counts for Human Cultures Behavioral and Social Sciences in Purdue University Core. Indiana students may get Indiana College Core credit too.",
  },
  HUM: {
    kind: "ucc",
    headline: "Humanities",
    detail:
      "Counts for Human Cultures Humanities in Purdue University Core. Indiana students may get Indiana College Core credit too.",
  },
  MQR: {
    kind: "ucc",
    headline: "Math and quantitative reasoning",
    detail:
      "Counts for Mathematics and Quantitative Reasoning in Purdue University Core. Indiana students may get Indiana College Core credit too.",
  },
  SCI: {
    kind: "ucc",
    headline: "Science",
    detail:
      "Counts for Science in Purdue University Core. Indiana students may get Indiana College Core credit too.",
  },
  STS: {
    kind: "ucc",
    headline: "Science, technology, and society",
    detail:
      "Counts for Science, Technology, and Society in Purdue University Core. Indiana students may get Indiana College Core credit too.",
  },
  UIL: {
    kind: "ucc",
    headline: "Information literacy",
    detail:
      "Counts for Information Literacy in Purdue University Core. Indiana students may get Indiana College Core credit too.",
  },
  UOC: {
    kind: "ucc",
    headline: "Oral communication",
    detail:
      "Counts for Oral Communication in Purdue University Core. Indiana students may get Indiana College Core credit too.",
  },
  UWC: {
    kind: "ucc",
    headline: "Written communication",
    detail:
      "Counts for Written Communication in Purdue University Core. Indiana students may get Indiana College Core credit too.",
  },
  // Dual foundational outcomes (registrar table)
  BHS: {
    kind: "ucc",
    headline: "Two core outcomes",
    detail: "Counts toward Behavioral and Social Sciences and Humanities in Purdue University Core.",
  },
  BIL: {
    kind: "ucc",
    headline: "Two core outcomes",
    detail: "Counts toward Behavioral and Social Sciences and Information Literacy in Purdue University Core.",
  },
  BST: {
    kind: "ucc",
    headline: "Two core outcomes",
    detail: "Counts toward Behavioral and Social Sciences and Science, Technology, and Society in Purdue University Core.",
  },
  HST: {
    kind: "ucc",
    headline: "Two core outcomes",
    detail: "Counts toward Humanities and Science, Technology, and Society in Purdue University Core.",
  },
  HUW: {
    kind: "ucc",
    headline: "Two core outcomes",
    detail: "Counts toward Humanities and Written Communication in Purdue University Core.",
  },
  IST: {
    kind: "ucc",
    headline: "Two core outcomes",
    detail: "Counts toward Information Literacy and Science, Technology, and Society in Purdue University Core.",
  },
  ILW: {
    kind: "ucc",
    headline: "Two core outcomes",
    detail: "Counts toward Information Literacy and Written Communication in Purdue University Core.",
  },
  SST: {
    kind: "ucc",
    headline: "Two core outcomes",
    detail: "Counts toward Science and Science, Technology, and Society in Purdue University Core.",
  },
  // General undistributed (registrar table and guide)
  TFR: {
    kind: "general",
    headline: "Transfer credit",
    detail:
      "Purdue could not line this up with a specific course taught here. It still counts as college credit. Your advisor decides how it may apply to your degree.",
  },
  XTRA: {
    kind: "general",
    headline: "Extra credit hours",
    detail:
      "You earned more hours on the transfer course than the Purdue equivalent. This line is the extra. Your advisor decides how it may apply.",
  },
  UND: {
    kind: "general",
    headline: "Reviewed, not equivalent",
    detail:
      "Purdue reviewed this and did not find a matching course. It still counts as credit in this subject area. Your advisor decides how it may apply.",
  },
  XXX: {
    kind: "general",
    headline: "Not fully evaluated",
    detail:
      "Purdue will count this at least as undistributed credit. For a full course review, send your syllabus to transfercredit@purdue.edu.",
  },
  PDM: {
    kind: "general",
    headline: "Special category",
    detail: "Check your transfer credit report or ask the Registrar how this line applies.",
  },
};

const CODE_RE = /^(\d)X([A-Z]+)$/i;

export type DecodedUndistributed = UndistributedMeaning & {
  raw: string;
  levelDigit: string;
  suffix: string;
  /** e.g. first-year level */
  levelHint: string;
};

function levelHintFromDigit(d: string): string {
  const n = parseInt(d, 10);
  if (n === 1) return "Typically first year level.";
  if (n === 2) return "Typically second year level.";
  if (n === 3) return "Typically third year level.";
  if (n === 4) return "Typically fourth year level.";
  if (n === 5) return "Typically fifth year or above.";
  return "Level follows the first digit of the course number.";
}

/**
 * Returns decoded info if `course` looks like NxSUFFIX (e.g. 1XHUM), else null.
 */
export function decodeUndistributedCourseCode(course: string): DecodedUndistributed | null {
  const trimmed = course.trim();
  const m = trimmed.match(CODE_RE);
  if (!m) return null;
  const levelDigit = m[1];
  const suffix = m[2].toUpperCase();
  const base = SUFFIXES[suffix];
  const levelHint = levelHintFromDigit(levelDigit);

  if (!base) {
    return {
      kind: "general",
      headline: "Undistributed code",
      detail:
        "Purdue put this code on the equivalency list. Your official transfer credit report is the final word. Ask your advisor if you are unsure.",
      raw: trimmed,
      levelDigit,
      suffix,
      levelHint,
    };
  }

  return {
    ...base,
    raw: trimmed,
    levelDigit,
    suffix,
    levelHint,
  };
}

export function isUndistributedCourseCode(course: string): boolean {
  return CODE_RE.test(course.trim());
}

export function undistributedKicker(kind: UndistributedKind): string {
  return kind === "ucc" ? "University Core" : "Undistributed credit";
}
