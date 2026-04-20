import { z } from "zod";

/** Public API: US (default) or International. "Outside US" still accepted for Purdue compatibility. */
export const locationSchema = z
  .enum(["US", "International", "Outside US"])
  .optional()
  .default("US")
  .transform((v): "US" | "International" => (v === "Outside US" ? "International" : v));

export const statesQuerySchema = z.object({
  location: locationSchema,
});

export const schoolsQuerySchema = z.object({
  state: z.string().min(1),
  location: locationSchema,
});

export const subjectsQuerySchema = z.object({
  schoolId: z.string().min(1),
  state: z.string().min(1),
  location: locationSchema,
});

export const coursesQuerySchema = z.object({
  schoolId: z.string().min(1),
  subject: z.string().min(1),
});

export const purdueCoursesQuerySchema = z.object({
  subject: z.string().min(1),
});

export const purdueCourseListQuerySchema = z.object({
  subject: z.string().min(1),
});

export const purdueCourseDestinationsQuerySchema = z.object({
  subject: z.string().min(1),
  course: z.string().min(1),
});

export const purdueLocationsQuerySchema = z.object({
  subject: z.string().min(1),
  course: z.string().min(1),
});

export const purdueStatesQuerySchema = z.object({
  location: z.string().min(1),
  subject: z.string().min(1),
  course: z.string().min(1),
});

export const purdueSchoolsQuerySchema = z.object({
  location: z.string().min(1),
  state: z.string().min(1),
  subject: z.string().min(1),
  course: z.string().min(1),
});

export const searchRowSchema = z.object({
  location: z.string().default("US"),
  state: z.string().min(1),
  school: z.string().min(1),
  subject: z.string().optional().default(""),
  course: z.string().optional().default(""),
});

export const searchBodySchema = z.object({
  rows: z.array(searchRowSchema).min(1).max(5),
});

export const purdueSearchRowSchema = z.object({
  subject: z.string().min(1),
  course: z.string().min(1),
  location: z.string().min(1),
  state: z.string().min(1),
  school: z.string().min(1),
});

export const purdueSearchBodySchema = z.object({
  rows: z.array(purdueSearchRowSchema).min(1).max(5),
});

export const allSchoolsQuerySchema = z.object({
  location: locationSchema,
});

export const schoolEquivalenciesQuerySchema = z.object({
  schoolId: z.string().min(1),
  state: z.string().min(1),
  location: locationSchema,
});

export const purdueCatalogQuerySchema = z.object({});

export const purdueCourseDirectoryQuerySchema = z.object({});

export const purdueCourseEquivalenciesQuerySchema = z.object({
  subject: z.string().min(1),
  course: z.string().min(1),
});
