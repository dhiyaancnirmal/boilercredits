import { describe, expect, it } from "vitest";
import { rankList, scoreText } from "../frontend/lib/fuzzy";
import { resolveStateQuery, searchSchools } from "../frontend/lib/school-search";

describe("fuzzy search", () => {
  it("scores exact matches highest", () => {
    expect(scoreText("ma 16100", "MA 16100 Plane Analytic Geometry")).toBeGreaterThan(
      scoreText("ma 16100", "CS 18000 Object Oriented Programming")
    );
  });

  it("ranks close matches ahead of unrelated results", () => {
    const items = [
      { name: "Indiana University Bloomington" },
      { name: "Lansing Community College" },
      { name: "Ivy Tech Community College" },
    ];

    expect(rankList(items, "ivy tech", (item) => item.name, 3).map((item) => item.name)).toEqual([
      "Ivy Tech Community College",
    ]);
  });

  it("handles small typos with edit-distance matching", () => {
    expect(scoreText("Astin College", "Austin College")).toBeGreaterThan(
      scoreText("Astin College", "Bates College")
    );

    const items = [
      { name: "Austin College" },
      { name: "Bates College" },
      { name: "Colby College" },
    ];

    expect(rankList(items, "Astin College", (item) => item.name, 3).map((item) => item.name)[0]).toBe(
      "Austin College"
    );
  });

  it("treats exact state abbreviations as state filters", () => {
    expect(resolveStateQuery("IN ")).toBe("IN");
    expect(resolveStateQuery("Indiana")).toBe("IN");

    const schools = [
      { name: "Ivy Tech Community College", state: "IN" },
      { name: "Lansing Community College", state: "MI" },
      { name: "Indiana University Bloomington", state: "IN" },
    ];

    expect(searchSchools(schools, "IN ").map((school) => school.name)).toEqual([
      "Ivy Tech Community College",
      "Indiana University Bloomington",
    ]);
  });
});
