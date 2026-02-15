import { OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { registry } from "../src/schemas.js";
import { writeFileSync } from "fs";

const generator = new OpenApiGeneratorV3(registry.definitions);

const document = generator.generateDocument({
  openapi: "3.0.0",
  info: {
    title: "Windmill Service",
    description:
      "Workflow orchestration service wrapping Windmill. Translates internal DAG format to Windmill OpenFlow, manages workflow lifecycle, and tracks executions.",
    version: "1.0.0",
  },
  servers: [
    {
      url: process.env.SERVICE_URL ?? "https://windmill.mcpfactory.org",
    },
  ],
});

writeFileSync("openapi.json", JSON.stringify(document, null, 2));
console.log("Generated openapi.json");
