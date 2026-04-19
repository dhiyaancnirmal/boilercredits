import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseCourses, parseEquivalencyReport, parseSchools, parseStates, parseSubjects } from "../src/services/purdue-parser";

const statesFixture = readFileSync(new URL("./fixtures/purdue-text.txt", import.meta.url), "utf8");
const schoolsFixture = readFileSync(new URL("./fixtures/purdue-schools.txt", import.meta.url), "utf8");
const subjectsFixture = readFileSync(new URL("./fixtures/purdue-subjects.txt", import.meta.url), "utf8");
const coursesFixture = readFileSync(new URL("./fixtures/purdue-courses.txt", import.meta.url), "utf8");
const reportFixture = readFileSync(new URL("./fixtures/purdue-report.html", import.meta.url), "utf8");

describe("Purdue parsers", () => {
  it("parses states", () => {
    expect(parseStates(statesFixture)).toEqual([
      { name: "Indiana", code: "IN" },
      { name: "Michigan", code: "MI" },
    ]);
  });

  it("parses schools", () => {
    expect(parseSchools(schoolsFixture)).toEqual([
      { name: "Ivy Tech Community College", id: "001816", state: "IN" },
      { name: "Lansing Community College", id: "002351", state: "MI" },
    ]);
  });

  it("parses subjects", () => {
    expect(parseSubjects(subjectsFixture)).toEqual([
      { code: "ENG", name: "English" },
      { code: "MATH", name: "Mathematics" },
    ]);
  });

  it("parses courses", () => {
    expect(parseCourses(coursesFixture)).toEqual([
      { code: "111", name: "Composition I" },
      { code: "16100", name: "Plane Analytic Geometry and Calculus I" },
    ]);
  });

  it("parses equivalency rows", () => {
    expect(parseEquivalencyReport(reportFixture)).toEqual([
      {
        transferInstitution: "Ivy Tech Community College - IN",
        transferSubject: "ENG",
        transferCourse: "111",
        transferTitle: "Composition I",
        transferCredits: "3",
        purdueSubject: "ENGL",
        purdueCourse: "10600",
        purdueTitle: "First-Year Composition",
        purdueCredits: "3",
      },
    ]);
  });

  it("ignores malformed report rows that are missing the Purdue credits cell", () => {
    const malformedRow = `
      <table class="reportTable">
        <tr>
          <th>Institution</th>
          <th>Transfer Subject</th>
          <th>Transfer Course</th>
          <th>Transfer Title</th>
          <th>Transfer Credits</th>
          <th>Purdue Subject</th>
          <th>Purdue Course</th>
          <th>Purdue Title</th>
          <th>Purdue Credits</th>
        </tr>
        <tr>
          <td>Ivy Tech Community College - IN</td>
          <td>ENG</td>
          <td>111</td>
          <td>Composition I</td>
          <td>3</td>
          <td>ENGL</td>
          <td>10600</td>
          <td>First-Year Composition</td>
        </tr>
      </table>
    `;

    expect(parseEquivalencyReport(malformedRow)).toEqual([]);
  });
});
