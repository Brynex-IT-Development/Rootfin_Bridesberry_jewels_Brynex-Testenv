// backend/controllers/BillExtractController.js
// Extracts product line items (name, quantity, cost price, MRP, HSN) from an
// uploaded bill image or PDF using Claude vision, and returns structured JSON
// that the frontend can drop straight into the bill line-item table.

import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5";

const SUPPORTED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];

const EXTRACTION_PROMPT = `You are a data-extraction assistant for a jewellery/retail billing system.
The attached file is a purchase bill / invoice / product list (photo, scan, or PDF).

Extract EVERY distinct product line item. For each item return:
- "itemName": the product name/description as written (string, required)
- "quantity": the quantity as a number (default 1 if not shown)
- "costPrice": the purchase/cost/rate per unit as a number (0 if not shown)
- "mrp": the MRP / selling price per unit as a number (0 if not shown)
- "hsnCode": the HSN/SAC code if present, else "" (string)

Rules:
- Return ONLY a compact JSON object, no prose, no markdown fences.
- Shape: {"items":[ {"itemName":"...","quantity":1,"costPrice":0,"mrp":0,"hsnCode":""}, ... ]}
- Numbers must be plain numbers (no currency symbols, no commas).
- Do not invent items. If a value is unreadable, use 0 (or "" for hsnCode).
- Ignore totals, taxes, subtotals, vendor/address lines — only actual product rows.
- If no product rows are found, return {"items":[]}.`;

/**
 * POST /api/purchase/bills/extract-from-file
 * body: { fileData: <base64 string, no data: prefix>, mediaType: "image/png" | "application/pdf" }
 */
export const extractBillFromFile = async (req, res) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        success: false,
        message:
          "AI extraction is not configured. Set ANTHROPIC_API_KEY in the backend .env file.",
      });
    }

    let { fileData, mediaType } = req.body || {};
    if (!fileData || !mediaType) {
      return res.status(400).json({
        success: false,
        message: "fileData (base64) and mediaType are required.",
      });
    }

    // Strip a data: URL prefix if the client sent one.
    if (typeof fileData === "string" && fileData.startsWith("data:")) {
      const comma = fileData.indexOf(",");
      if (comma !== -1) fileData = fileData.slice(comma + 1);
    }
    fileData = String(fileData).replace(/\s/g, ""); // base64 must have no whitespace/newlines

    const isPdf = mediaType === "application/pdf";
    const isImage = SUPPORTED_IMAGE_TYPES.includes(mediaType);
    if (!isPdf && !isImage) {
      return res.status(400).json({
        success: false,
        message: `Unsupported mediaType "${mediaType}". Use a PNG/JPG/GIF/WEBP image or a PDF.`,
      });
    }

    const client = new Anthropic({ apiKey });

    const fileBlock = isPdf
      ? {
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: fileData },
        }
      : {
          type: "image",
          source: { type: "base64", media_type: mediaType, data: fileData },
        };

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4000,
      messages: [
        {
          role: "user",
          content: [fileBlock, { type: "text", text: EXTRACTION_PROMPT }],
        },
      ],
    });

    // Gather text output.
    let raw = "";
    for (const block of response.content || []) {
      if (block.type === "text") raw += block.text;
    }
    raw = raw.trim();

    // Be tolerant: pull the first {...} JSON object out of the text.
    let parsed;
    try {
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      const jsonStr = start !== -1 && end !== -1 ? raw.slice(start, end + 1) : raw;
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      return res.status(502).json({
        success: false,
        message: "Could not parse AI response. Please try a clearer image.",
        rawPreview: raw.slice(0, 500),
      });
    }

    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    const cleaned = items
      .map((it) => ({
        itemName: String(it?.itemName ?? "").trim(),
        quantity: Number.isFinite(Number(it?.quantity)) && Number(it?.quantity) > 0
          ? Number(it.quantity)
          : 1,
        costPrice: Number.isFinite(Number(it?.costPrice)) ? Number(it.costPrice) : 0,
        mrp: Number.isFinite(Number(it?.mrp)) ? Number(it.mrp) : 0,
        hsnCode: String(it?.hsnCode ?? "").trim(),
      }))
      .filter((it) => it.itemName.length > 0);

    return res.json({
      success: true,
      items: cleaned,
      count: cleaned.length,
      model: MODEL,
    });
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      return res.status(500).json({
        success: false,
        message: "Anthropic authentication failed. Check/rotate ANTHROPIC_API_KEY.",
      });
    }
    if (error instanceof Anthropic.RateLimitError) {
      return res.status(429).json({
        success: false,
        message: "AI service rate limited. Please try again in a moment.",
      });
    }
    console.error("Bill extraction error:", error);
    return res.status(500).json({
      success: false,
      message: error?.message || "Failed to extract bill items.",
    });
  }
};
