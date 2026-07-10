import { afterEach } from "vitest";
import { resetRecorderFactory } from "../src/media";

// Every test starts with the default (real) recorder factory; browser tests
// install their own fake via installMockRecorder().
afterEach(() => {
  resetRecorderFactory();
});
