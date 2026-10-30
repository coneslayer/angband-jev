import { describe, it, expect } from "vitest";
import { healthWords, hungerWord } from "./perception.js";

describe("healthWords", () => {
  it("matches the look command's bands", () => {
    expect(healthWords(10, 10, true)).toBe("unhurt");
    expect(healthWords(7, 10, true)).toBe("somewhat wounded");
    expect(healthWords(3, 10, true)).toBe("wounded");
    expect(healthWords(1, 10, true)).toBe("badly wounded");
    expect(healthWords(1, 20, true)).toBe("almost dead");
  });
  it("uses the non-living words for undead and nonliving monsters", () => {
    expect(healthWords(10, 10, false)).toBe("undamaged");
    expect(healthWords(1, 20, false)).toBe("almost destroyed");
  });
});

describe("hungerWord", () => {
  it("names the status-bar grades", () => {
    expect(hungerWord(14000)).toBe("Full");
    expect(hungerWord(6000)).toBe("Fed");
    expect(hungerWord(1500)).toBe("Hungry");
    expect(hungerWord(800)).toBe("Weak");
    expect(hungerWord(300)).toBe("Faint");
    expect(hungerWord(50)).toBe("Starving");
  });
});
