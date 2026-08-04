#!/usr/bin/env node
/** Reports whether a variable the service holds leaked into this process. */
process.stdout.write(
  JSON.stringify({
    content: [
      {
        type: "text",
        text: `INFERENCE_LENS_API_KEY=${process.env.INFERENCE_LENS_API_KEY ?? "absent"}`,
      },
    ],
  }),
);
