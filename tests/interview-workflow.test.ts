import { describe, expect, it } from "vitest";
import {
  isValidTimeZone,
  parseZonedDateTime,
  synchronizedJobStatus,
  targetStatusForInterviewStage,
} from "../src/lib/interview-workflow";
import { formatDateTimeInput } from "../src/lib/format";

describe("interview workflow", () => {
  it("maps stages to pipeline states", () => {
    expect(targetStatusForInterviewStage("recruiter_screen")).toBe("screening");
    expect(targetStatusForInterviewStage("technical")).toBe("interviewing");
    expect(targetStatusForInterviewStage("offer_discussion")).toBe("offer");
  });

  it("promotes jobs without regressing or overwriting terminal states", () => {
    expect(synchronizedJobStatus("applied", "recruiter_screen")).toBe("screening");
    expect(synchronizedJobStatus("screening", "technical")).toBe("interviewing");
    expect(synchronizedJobStatus("offer", "technical")).toBe("offer");
    expect(synchronizedJobStatus("rejected", "final")).toBe("rejected");
    expect(synchronizedJobStatus("applied", "technical", "cancelled")).toBe("applied");
    expect(synchronizedJobStatus("interviewing", "offer_discussion", "failed")).toBe("interviewing");
  });

  it("parses local interview time using the selected IANA timezone", () => {
    const instant = parseZonedDateTime("2026-08-04T10:00", "Europe/Prague");
    expect(instant.toISOString()).toBe("2026-08-04T08:00:00.000Z");
    expect(formatDateTimeInput(instant, "Europe/Prague")).toBe("2026-08-04T10:00");
  });

  it("rejects invalid zones and local times skipped by daylight saving", () => {
    expect(isValidTimeZone("Europe/Prague")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(() => parseZonedDateTime("2026-03-29T02:30", "Europe/Prague")).toThrow(/does not exist/);
  });
});
