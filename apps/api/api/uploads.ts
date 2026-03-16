import {
  RequestError,
  createUploadAnalysis,
} from "../src/api-handlers.js";
import {
  readFormData,
  sendJson,
  sendMethodNotAllowed,
  type VercelRequestLike,
  type VercelResponseLike,
} from "../src/vercel-utils.js";

export default async function handler(req: VercelRequestLike, res: VercelResponseLike) {
  if (req.method !== "POST") {
    return sendMethodNotAllowed(res, "POST", req.method);
  }

  try {
    const formData = await readFormData(req);
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return sendJson(res, 400, { message: "Missing file field" });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const response = await createUploadAnalysis({
      buffer,
      filename: file.name,
      mimeType: file.type,
    });

    return sendJson(res, 200, response);
  } catch (error) {
    if (error instanceof RequestError) {
      return sendJson(res, error.statusCode, { message: error.message });
    }

    const message = error instanceof Error ? error.message : "Upload failed";
    return sendJson(res, 500, { message });
  }
}
