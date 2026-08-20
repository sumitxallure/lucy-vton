# Lucy Live Virtual Try-On

A separate React/TypeScript frontend and Node/TypeScript backend for Decart Lucy's live virtual try-on model.

## Setup

1. Install dependencies:

   ```powershell
   npm install
   ```

2. Copy `backend/.env.example` to `backend/.env` and add your Decart and Supabase values:

   ```env
   DECART_API_KEY=your_key_here
   PORT=3001
   ALLOWED_ORIGINS=http://localhost:5173
   SUPABASE_URL=https://your-project-reference.supabase.co
   SUPABASE_SECRET_KEY=sb_secret_xxxxxxxxx
   SUPABASE_GARMENTS_BUCKET=garments
   ```

3. In Supabase SQL Editor, run `supabase/migrations/20260810143000_create_garments.sql` once. The backend will create the private `garments` Storage bucket automatically on the first successful upload.

4. Optionally copy `frontend/.env.example` to `frontend/.env` when the API is hosted somewhere other than `http://localhost:3001`.

5. Run both apps:

   ```powershell
   npm run dev
   ```

6. Open `http://localhost:5173`, upload garment images, start the camera, and start live try-on.

## Garment descriptions

Every garment requires a plain-text sidecar description. Select the image and text file together using matching base names:

```text
dark-green-jacket.jpg
dark-green-jacket.txt
```

The human-readable format is:

```text
Garment Name: Dark Green Utility Jacket
Action: Replace
Worn Area: Upper body
Intended wearer: Men
Garment Type: Hooded utility jacket
Color: Dark green
Material or Texture: Matte woven fabric
Fit: Relaxed fit
Length: Hip length
Sleeves: Long sleeves with elastic cuffs
Neckline or Collar: Attached hood
Closure: Front zipper
Open or Closed: Zipped closed
Pockets: Two large utility pockets on the front
Pattern: Solid
Visible Logo, Graphic, or Text: Small white logo on the left chest
Other Visible Details: Slightly dropped shoulders
```

`Action` accepts `Replace` or `Add`. `Worn Area` accepts `Upper body`, `Lower body`, `Full outfit`, `Footwear`, `Hat or headwear`, `Necklace`, or `Accessory`. `Intended wearer` is optional and accepts `Men`, `Women`, `Unisex`, or `Not specified`; when omitted, the app infers it from the garment name/type/description when possible. The app parses the text, maps it into its internal structured data, and generates the prompt recommended by Decart's VTON prompting guide.

When a garment image and matching TXT are uploaded together, the backend saves the image in a private Supabase Storage bucket and saves the parsed description/prompt in the `garments` table. On page load, the frontend fetches the saved wardrobe and converts each stored image back into a browser `File` object before calling Lucy.

The app also wraps every generated VTON prompt with production safety instructions:

- close or fasten jackets, shirts, coats, blazers, vests, hoodies, suits, and similar garments when physically possible
- fit the garment to the visible adult wearer while preserving the garment's menswear, womenswear, unisex, or original design category
- preserve the user's existing inner layer or add a fitted opaque matching inner layer when a garment must remain open, transparent, cut out, or moves during try-on
- prevent exposed chest, stomach, torso skin gaps, underwear, or private areas
- preserve unchanged outfit regions, such as keeping lower-body clothing unchanged for upper-body try-on
- keep pose, face, body shape, background, and lighting stable
- fit the garment naturally to shoulders, waist, sleeves, hems, and visible edges

## Production notes

- Serve the frontend over HTTPS so browsers permit camera access. `localhost` is allowed over HTTP for development.
- Set `ALLOWED_ORIGINS` to the deployed frontend origin. Multiple origins can be comma-separated.
- The permanent Decart API key stays on the backend. The browser receives a short-lived token restricted to `lucy-vton-latest` and the configured web origin.
- The Supabase secret key stays on the backend. Do not expose `SUPABASE_SECRET_KEY` through any `VITE_*` frontend variable.
- Recordings are created in the browser as WebM, using Lucy's edited video and the user's original microphone audio.
