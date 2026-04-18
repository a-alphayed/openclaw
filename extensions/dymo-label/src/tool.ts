import { Type, type Static } from "@sinclair/typebox";
import type { AnyAgentTool, OpenClawPluginApi } from "../api.js";
import { renderLabelPdf } from "./label-renderer.js";
import { printPdf } from "./printer.js";
import type { DymoLabelPluginConfig, LabelContent } from "./types.js";

const DymoLabelToolSchema = Type.Object(
  {
    partNumber: Type.String({
      description: "Internal part number (e.g. 123456-GEAR). Printed bold on the label.",
    }),
    oemPartNumber: Type.String({
      description: "OEM/manufacturer part number.",
    }),
    description: Type.String({
      description: "Part description. Will be truncated to fit a single line on the label.",
    }),
    binLocation: Type.Optional(
      Type.String({
        description:
          "Storage bin or shelf identifier (e.g. BIN A-14). Printed right-aligned on the top line.",
      }),
    ),
    copies: Type.Optional(
      Type.Number({
        description: "Number of copies to print. Default: 1. Maximum: 50.",
        minimum: 1,
        maximum: 50,
      }),
    ),
  },
  { additionalProperties: false },
);

type DymoLabelToolParams = Static<typeof DymoLabelToolSchema>;

export function createDymoLabelTool(opts: {
  api: OpenClawPluginApi;
  config: DymoLabelPluginConfig;
}): AnyAgentTool {
  const { api, config } = opts;

  return {
    name: "dymo-label",
    label: "Dymo Label",
    description:
      "Print an asset or parts label on a Dymo LabelWriter 550 over Tailscale. " +
      "The label shows the internal part number, OEM part number, description, " +
      "and optional bin location on a 30336 (1×2⅛ in) label.",
    parameters: DymoLabelToolSchema,

    async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
      const p = rawParams as DymoLabelToolParams;

      if (!config.tailscaleHost) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: tailscaleHost is not configured for the dymo-label plugin. Set it in the plugin config.",
            },
          ],
          isError: true,
          details: { error: "tailscaleHost-not-configured" },
        };
      }

      const copies = Math.min(Math.max(p.copies ?? 1, 1), 50);

      const content: LabelContent = {
        partNumber: p.partNumber,
        oemPartNumber: p.oemPartNumber,
        description: p.description,
        binLocation: p.binLocation ?? config.defaultBinLocation ?? "",
      };

      const pdfBuffer = await renderLabelPdf(content, copies);

      const sshUser = config.sshUser ?? process.env.USER ?? process.env.USERNAME ?? "root";

      const result = await printPdf(pdfBuffer, {
        tailscaleHost: config.tailscaleHost,
        sshUser,
        printerName: config.printerName,
        logger: api.logger,
      });

      const resultSummary = {
        status: "printed",
        jobId: result.jobId,
        printer: result.printer,
        host: result.host,
        copies,
        partNumber: content.partNumber,
        oemPartNumber: content.oemPartNumber,
      };
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(resultSummary, null, 2),
          },
        ],
        details: resultSummary,
      };
    },
  };
}
