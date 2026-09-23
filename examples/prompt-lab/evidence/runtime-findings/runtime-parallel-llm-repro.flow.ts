import { flow } from "@relayflows/surface";
const s = { type: "object", required: ["x"], properties: { x: { type: "number" } } };
export default flow<{ n: number }>("repro-par", async (f, input) => {
  await f.run("echo start");
  const xs = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => f.llm(`Return {"x": ${i}+${input.n}} as JSON only.`, { output: s, model: "claude-haiku-4-5-20251001" })));
  await f.run(`echo ${JSON.stringify(JSON.stringify(xs))}`);
  f.done("success");
});
