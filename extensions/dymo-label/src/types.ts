/** Dymo 30336 Small Multipurpose Label — 1" × 2⅛", horizontal orientation. */
export const LABEL_WIDTH_PT = 153; // 2.125" × 72pt/in
export const LABEL_HEIGHT_PT = 72; // 1" × 72pt/in
export const LABEL_MARGIN = 4; // pt, all sides

export type DymoLabelPluginConfig = {
  tailscaleHost?: string;
  sshUser?: string;
  printerName?: string;
  defaultBinLocation?: string;
};

export type LabelContent = {
  partNumber: string;
  oemPartNumber: string;
  description: string;
  binLocation: string;
};
