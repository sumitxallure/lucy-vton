import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import { createDecartClient } from "@decartai/sdk";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import multer from "multer";

dotenv.config();

const app = express();
const port = Number(process.env.PORT ?? 3001);
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const garmentsBucket = process.env.SUPABASE_GARMENTS_BUCKET ?? "garments";
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 12 * 1024 * 1024,
    files: 1,
    fields: 4,
  },
  fileFilter(_request, file, callback) {
    if (file.mimetype.startsWith("image/")) callback(null, true);
    else callback(new Error("Only image uploads are supported."));
  },
});

type StoredGarmentRow = {
  id: string;
  display_name: string;
  image_path: string;
  image_filename: string;
  image_mime_type: string;
  description_filename: string | null;
  raw_description: string;
  parsed_description: unknown;
  generated_prompt: string;
  is_visible: boolean;
  created_at: string;
};

let cachedSupabase: SupabaseClient | null | undefined;

function supabaseConfigured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY);
}

function getSupabase() {
  if (!supabaseConfigured()) return null;
  if (cachedSupabase === undefined) {
    const supabaseUrl = new URL(process.env.SUPABASE_URL!).origin;
    cachedSupabase = createClient(supabaseUrl, process.env.SUPABASE_SECRET_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return cachedSupabase;
}

async function ensureGarmentsBucket(supabase: SupabaseClient) {
  const { data } = await supabase.storage.getBucket(garmentsBucket);
  if (data) return;
  const { error } = await supabase.storage.createBucket(garmentsBucket, {
    public: false,
    fileSizeLimit: 12 * 1024 * 1024,
    allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
  });
  if (error && !/already exists/i.test(error.message)) throw error;
}

function requireSupabase(response: express.Response) {
  const supabase = getSupabase();
  if (!supabase) {
    response.status(503).json({
      error: "Supabase is not configured. Add SUPABASE_URL and SUPABASE_SECRET_KEY to backend/.env and restart the API.",
    });
    return null;
  }
  return supabase;
}

function safeFileName(fileName: string) {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-");
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return fallback;
}

function delay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("Origin is not allowed"));
    },
  }),
);

app.get("/api/health", (_request, response) => {
  response.json({
    ok: true,
    decartConfigured: Boolean(process.env.DECART_API_KEY),
    supabaseConfigured: supabaseConfigured(),
  });
});

app.get("/api/wardrobe", async (_request, response) => {
  const supabase = requireSupabase(response);
  if (!supabase) return;

  try {
    const loadVisibleGarments = () => supabase
      .from("garments")
      .select("id, display_name, image_path, image_filename, image_mime_type, description_filename, raw_description, parsed_description, generated_prompt, is_visible, created_at")
      .eq("is_visible", true)
      .order("created_at", { ascending: false });
    const loadLegacyGarments = () => supabase
      .from("garments")
      .select("id, display_name, image_path, image_filename, image_mime_type, description_filename, raw_description, parsed_description, generated_prompt, created_at")
      .order("created_at", { ascending: false });

    let { data, error } = await loadVisibleGarments();
    if (error && /jwt issued at future/i.test(error.message)) {
      await delay(1500);
      ({ data, error } = await loadVisibleGarments());
    }
    if (error && /is_visible|schema cache|column/i.test(error.message)) {
      console.warn("Wardrobe visibility column is not available yet; falling back to legacy wardrobe load.");
      const legacyResult = await loadLegacyGarments();
      data = legacyResult.data?.map((garment) => ({ ...garment, is_visible: true })) ?? null;
      error = legacyResult.error;
    }
    if (error) throw error;

    response.setHeader("Cache-Control", "no-store");
    response.json({
      garments: (data ?? []).map((garment: StoredGarmentRow) => ({
        id: garment.id,
        name: garment.display_name,
        imageUrl: `/api/wardrobe/${garment.id}/image`,
        imageFileName: garment.image_filename,
        imageMimeType: garment.image_mime_type,
        descriptionFileName: garment.description_filename,
        description: garment.parsed_description,
        rawDescription: garment.raw_description,
        prompt: garment.generated_prompt,
        isVisible: garment.is_visible,
        createdAt: garment.created_at,
      })),
    });
  } catch (error) {
    const message = errorMessage(error, "Could not load wardrobe.");
    console.error("Wardrobe load failed:", message);
    response.status(500).json({ error: message });
  }
});

app.get("/api/wardrobe/:id/image", async (request, response) => {
  const supabase = requireSupabase(response);
  if (!supabase) return;

  try {
    const { data: garment, error: garmentError } = await supabase
      .from("garments")
      .select("image_path, image_mime_type, image_filename")
      .eq("id", request.params.id)
      .single();
    if (garmentError) throw garmentError;

    const { data, error } = await supabase.storage.from(garmentsBucket).download(garment.image_path);
    if (error) throw error;

    const arrayBuffer = await data.arrayBuffer();
    response.setHeader("Cache-Control", "private, max-age=60");
    response.setHeader("Content-Type", garment.image_mime_type);
    response.setHeader("Content-Disposition", `inline; filename="${safeFileName(garment.image_filename)}"`);
    response.send(Buffer.from(arrayBuffer));
  } catch (error) {
    const message = errorMessage(error, "Could not load garment image.");
    console.error("Garment image load failed:", message);
    response.status(404).json({ error: message });
  }
});

app.post("/api/wardrobe", upload.single("image"), async (request, response) => {
  const supabase = requireSupabase(response);
  if (!supabase) return;
  if (!request.file) {
    response.status(400).json({ error: "Upload a garment image." });
    return;
  }

  const rawDescription = String(request.body.rawDescription ?? "").trim();
  const parsedDescriptionText = String(request.body.description ?? "").trim();
  const generatedPrompt = String(request.body.prompt ?? "").trim();
  const descriptionFileName = String(request.body.descriptionFileName ?? "").trim() || null;
  if (!rawDescription || !parsedDescriptionText || !generatedPrompt) {
    response.status(400).json({ error: "Image, raw description, parsed description, and prompt are required." });
    return;
  }

  let parsedDescription: { display_name?: string };
  try {
    parsedDescription = JSON.parse(parsedDescriptionText) as { display_name?: string };
  } catch {
    response.status(400).json({ error: "Parsed description must be valid JSON." });
    return;
  }

  const id = crypto.randomUUID();
  const imageFileName = safeFileName(request.file.originalname);
  const imagePath = `${id}/${imageFileName}`;

  try {
    await ensureGarmentsBucket(supabase);
    const { error: uploadError } = await supabase.storage
      .from(garmentsBucket)
      .upload(imagePath, request.file.buffer, {
        contentType: request.file.mimetype,
        upsert: false,
      });
    if (uploadError) throw uploadError;

    const { data, error: insertError } = await supabase
      .from("garments")
      .insert({
        id,
        display_name: parsedDescription.display_name ?? imageFileName.replace(/\.[^.]+$/, ""),
        image_path: imagePath,
        image_filename: imageFileName,
        image_mime_type: request.file.mimetype,
        description_filename: descriptionFileName,
        raw_description: rawDescription,
        parsed_description: parsedDescription,
        generated_prompt: generatedPrompt,
        is_visible: true,
      })
      .select("id, display_name, image_filename, image_mime_type, description_filename, raw_description, parsed_description, generated_prompt, is_visible, created_at")
      .single();
    if (insertError) {
      await supabase.storage.from(garmentsBucket).remove([imagePath]);
      throw insertError;
    }

    response.status(201).json({
      garment: {
        id: data.id,
        name: data.display_name,
        imageUrl: `/api/wardrobe/${data.id}/image`,
        imageFileName: data.image_filename,
        imageMimeType: data.image_mime_type,
        descriptionFileName: data.description_filename,
        description: data.parsed_description,
        rawDescription: data.raw_description,
        prompt: data.generated_prompt,
        isVisible: data.is_visible,
        createdAt: data.created_at,
      },
    });
  } catch (error) {
    const message = errorMessage(error, "Could not save garment.");
    console.error("Wardrobe save failed:", message);
    response.status(500).json({ error: message });
  }
});

app.delete("/api/wardrobe/:id", async (request, response) => {
  const supabase = requireSupabase(response);
  if (!supabase) return;

  try {
    const { data: garment, error: selectError } = await supabase
      .from("garments")
      .select("image_path")
      .eq("id", request.params.id)
      .single();
    if (selectError) throw selectError;

    const { error: deleteError } = await supabase.from("garments").delete().eq("id", request.params.id);
    if (deleteError) throw deleteError;

    await supabase.storage.from(garmentsBucket).remove([garment.image_path]);
    response.status(204).send();
  } catch (error) {
    const message = errorMessage(error, "Could not delete garment.");
    console.error("Wardrobe delete failed:", message);
    response.status(500).json({ error: message });
  }
});

app.post("/api/decart-token", async (request, response) => {
  const apiKey = process.env.DECART_API_KEY;
  if (!apiKey) {
    response.status(503).json({
      error: "Decart is not configured. Add DECART_API_KEY to backend/.env and restart the API.",
    });
    return;
  }

  const requestOrigin = request.get("origin");
  if (requestOrigin && !allowedOrigins.includes(requestOrigin)) {
    response.status(403).json({ error: "This web origin is not allowed." });
    return;
  }

  try {
    const decart = createDecartClient({ apiKey });
    const token = await decart.tokens.create({
      expiresIn: 600,
      allowedModels: ["lucy-vton-latest"],
      ...(requestOrigin ? { allowedOrigins: [requestOrigin] } : {}),
      constraints: { realtime: { maxSessionDuration: 1800 } },
      metadata: { application: "lucy-live-try-on" },
    });

    response.setHeader("Cache-Control", "no-store");
    response.json(token);
  } catch (error) {
    const message = errorMessage(error, "Could not create a Decart token.");
    console.error("Decart token creation failed:", message);
    response.status(502).json({ error: message });
  }
});

app.use((_request, response) => {
  response.status(404).json({ error: "Not found" });
});

app.use(
  (error: Error, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(403).json({ error: error.message });
  },
);

app.listen(port, () => {
  console.log(`Lucy API listening on http://localhost:${port}`);
});
