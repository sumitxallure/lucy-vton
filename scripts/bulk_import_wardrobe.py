import argparse
import csv
import json
import mimetypes
import re
import sys
import uuid
from pathlib import Path
from urllib import error, request

import pdfplumber


REGION_BY_WORN_AREA = {
    "upper body": "upper_body",
    "lower body": "lower_body",
    "full body": "outfit",
    "full outfit": "outfit",
    "outfit": "outfit",
    "footwear": "footwear",
    "shoes": "footwear",
    "hat or headwear": "hat",
    "hat": "hat",
    "headwear": "hat",
    "necklace": "necklace",
    "accessory": "accessory",
    "accessories": "accessory",
}

REGION_LABELS = {
    "upper_body": "upper body garment",
    "lower_body": "lower body garment",
    "outfit": "outfit",
    "footwear": "footwear",
    "hat": "hat",
    "necklace": "necklace",
    "accessory": "accessory",
}

PRESERVE_INSTRUCTIONS = {
    "upper_body": "Keep lower body and shoes unchanged.",
    "lower_body": "Keep upper body and shoes unchanged.",
    "outfit": "Keep face, body, pose, background, and lighting unchanged.",
    "footwear": "Keep clothing unchanged.",
    "hat": "Keep clothing and face unchanged.",
    "necklace": "Keep clothing and face unchanged.",
    "accessory": "Keep clothing and face unchanged.",
}

CLOSURE_TERMS = [
    "jacket",
    "coat",
    "blazer",
    "vest",
    "cardigan",
    "hoodie",
    "zip",
    "zipper",
    "button",
    "button-up",
    "shirt",
    "overshirt",
    "tuxedo",
    "suit",
]

VTON_PROMPT_MAX_WORDS = 62

INTENDED_WEARER_LABELS = {
    "men": "menswear",
    "women": "womenswear",
    "unisex": "unisex",
    "not_specified": "original",
}

KNOWN_IMAGE_MATCHES = {
    "futuristic ivory padded sculptural outfit": "Ivory Padded Full Look.png",
    "futuristic ivory sculptural padded jacket": "Ivory Padded Jacket.png",
    "futuristic ivory sculptural wide leg trousers": "Ivory Padded Trousers.png",
    "futuristic yellow and black honeycomb structured outfit": "Yellow Black Honeycomb Full Look.png",
    "futuristic yellow and black honeycomb structured top": "Yellow Black Honeycomb Top.png",
    "futuristic yellow and black honeycomb structured trousers": "Yellow Black Honeycomb Trousers.png",
    "futuristic pink color block sculptural outfit": "Pink Color Block Full Look.png",
    "futuristic pink color block sculptural jacket": "Pink Color Block Jacket.png",
    "futuristic pink color block wide leg trousers": "Pink Color Block Trousers.png",
    "futuristic ivory sculptural color block outfit": "Ivory Blue Sculptural Full Look.png",
    "futuristic ivory and royal blue sculptural padded jacket": "Ivory Blue Sculptural Jacket.png",
    "futuristic ivory balloon trousers with color block panels": "Ivory Blue Sculptural Trousers.png",
    "futuristic yellow sculptural coat with black balloon trousers": "Yellow Black Sculptural Full Look.png",
    "bright yellow sculptural asymmetrical coat": "Yellow Sculptural Coat.png",
    "black sculptural balloon trousers": "Black Balloon Trousers.png",
    "earth tone sculptural printed coat and wide leg trousers": "Earth Tone Sculptural Full Look.png",
    "futuristic metallic lilac sculptural puffer outfit": "Metallic Lilac Puffer Full Look.png",
    "futuristic transparent pink and blue sculptural outfit": "Pink Blue Transparent Full Look.png",
}


def normalize_field_name(value):
    return re.sub(r"[^a-z0-9]", "", value.lower())


def lower_first(value):
    value = value.strip()
    return value[:1].lower() + value[1:] if value else ""


def with_article(value):
    value = lower_first(value)
    if not value or re.match(r"^(a|an|the)\s", value, re.I):
        return value
    return ("an " if re.match(r"^[aeiou]", value, re.I) else "a ") + value


def normalize_intended_wearer(value):
    if not value:
        return None
    normalized = re.sub(r"[^a-z]", "", value.lower())
    if normalized in ["men", "mens", "male", "man"]:
        return "men"
    if normalized in ["women", "womens", "female", "woman", "ladies"]:
        return "women"
    if normalized in ["unisex", "genderneutral", "neutral", "all"]:
        return "unisex"
    if normalized in ["notspecified", "unspecified", "unknown", "na"]:
        return "not_specified"
    return None


def infer_intended_wearer(*values):
    text = " ".join(value for value in values if value).lower()
    if re.search(r"\b(unisex|gender[-\s]?neutral)\b", text):
        return "unisex"
    if re.search(r"\b(mens|men's|men|male|man)\b", text):
        return "men"
    if re.search(r"\b(womens|women's|women|female|woman|ladies)\b", text):
        return "women"
    return "not_specified"


def parse_description(raw_text):
    fields = {}
    for line in raw_text.splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        value = value.strip()
        if value and not re.match(r"^(none|not visible|n/a)$", value, re.I):
            fields[normalize_field_name(key)] = value

    def required(label):
        value = fields.get(normalize_field_name(label))
        if not value:
            raise ValueError(f"{label} is required")
        return value

    display_name = required("Garment Name")
    action = required("Action").lower()
    worn_area = required("Worn Area").lower()
    garment_type = required("Garment Type")
    if action in ["replace", "substitute"]:
        operation = "substitute"
    elif action == "add":
        operation = "add"
    else:
        raise ValueError("Action must be Replace or Add")

    target_region = REGION_BY_WORN_AREA.get(worn_area)
    if not target_region:
        raise ValueError(f"Unsupported Worn Area: {worn_area}")

    def optional(label):
        return fields.get(normalize_field_name(label))

    intended_wearer = normalize_intended_wearer(optional("Intended wearer"))
    color = optional("Color")
    material = optional("Material or Texture")
    base = with_article(" ".join(lower_first(value) for value in [color, garment_type] if value))
    pattern = optional("Pattern")
    details = [
        with_article(optional("Fit")) if optional("Fit") else None,
        optional("Length"),
        optional("Sleeves"),
        with_article(optional("Neckline or Collar")) if optional("Neckline or Collar") else None,
        with_article(optional("Closure")) if optional("Closure") else None,
        optional("Open or Closed"),
        optional("Pockets"),
        "a solid design" if pattern and pattern.lower() == "solid" else (lower_first(pattern) + " pattern" if pattern else None),
        optional("Visible Logo, Graphic, or Text"),
        optional("Other Visible Details"),
    ]
    description = base
    if material:
        description += f" in {lower_first(material)}"
    clean_details = [lower_first(value) for value in details if value]
    if clean_details:
        description += ", with " + ", ".join(clean_details)

    return {
        "schema_version": 1,
        "display_name": display_name,
        "operation": operation,
        "target_region": target_region,
        "intended_wearer": intended_wearer or infer_intended_wearer(display_name, garment_type, description),
        "description": description,
    }


def generate_prompt(description):
    raw_details = re.sub(r"[\.\s]+$", "", description["description"])
    words = raw_details.split()
    details = raw_details if len(words) <= VTON_PROMPT_MAX_WORDS else re.sub(r"[,;:.]+$", "", " ".join(words[:VTON_PROMPT_MAX_WORDS])) + "."
    lower_details = details.lower()
    can_be_closed = any(term in lower_details for term in CLOSURE_TERMS)
    states_open_or_closed = re.search(r"\b(open|opened|closed|zipped|buttoned|fastened|unbuttoned)\b", details, re.I)
    closure = "Closed/fastened if possible." if can_be_closed and not states_open_or_closed else "Keep reference closure."
    safety = "No bare chest, stomach, underwear, or skin gaps. If open, transparent, cutout, or motion exposes skin, add fitted opaque matching inner layer."
    fit = "Natural fit, aligned shoulders, waist, sleeves, hems."
    preserve = PRESERVE_INSTRUCTIONS[description["target_region"]]
    intended_wearer = description.get("intended_wearer") or infer_intended_wearer(description["display_name"], description["description"])
    if intended_wearer == "not_specified":
        wearer = "Fit visible adult wearer; preserve original design."
    else:
        wearer = f"Fit visible adult wearer; preserve {INTENDED_WEARER_LABELS[intended_wearer]} design."
    tail = f"{wearer} {closure} {safety} {fit} {preserve}"
    if description["operation"] == "add":
        return f"Add {details} to the outfit. {tail}"
    return f"Substitute the {REGION_LABELS[description['target_region']]} with {details}. {tail}"


def extract_entries(pdf_path):
    text = ""
    with pdfplumber.open(str(pdf_path)) as pdf:
        for index, page in enumerate(pdf.pages):
            if index:
                text += "\n"
            text += page.extract_text() or ""
    text = re.sub(r"-\n(?=[a-z])", "", text)
    text = re.sub(r"\n(?=[a-z,;])", " ", text)
    entries = []
    for block in re.split(r"(?=Garment Name:)", text):
        block = block.strip()
        if not block.startswith("Garment Name:"):
            continue
        fields = {}
        current = None
        raw_lines = []
        for line in block.splitlines():
            if ":" in line:
                key, value = line.split(":", 1)
                current = key.strip()
                fields[current] = value.strip()
                raw_lines.append(f"{current}: {value.strip()}")
            elif current:
                fields[current] += " " + line.strip()
                raw_lines[-1] += " " + line.strip()
        entries.append({"fields": fields, "raw": "\n".join(raw_lines)})
    return entries


def tokens(value):
    value = re.sub(r"([a-z])([A-Z])", r"\1 \2", value)
    return set(re.findall(r"[a-z0-9]+", value.lower()))


def normalized_key(value):
    value = re.sub(r"([a-z])([A-Z])", r"\1 \2", value)
    return " ".join(re.findall(r"[a-z0-9]+", value.lower()))


def region_expected_words(entry):
    worn_area = entry["fields"].get("Worn Area", "").lower()
    garment_type = entry["fields"].get("Garment Type", "").lower()
    name = entry["fields"].get("Garment Name", "").lower()
    haystack = f"{worn_area} {garment_type} {name}"
    if "upper" in haystack or "jacket" in haystack or "top" in haystack or "coat" in haystack:
        return ["jacket", "top", "coat"]
    if "lower" in haystack or "trouser" in haystack or "pant" in haystack:
        return ["trousers", "pants"]
    return ["full", "look", "outfit"]


def score_match(entry, image_path):
    name_tokens = tokens(entry["fields"].get("Garment Name", ""))
    color_tokens = tokens(entry["fields"].get("Color", ""))
    type_tokens = tokens(entry["fields"].get("Garment Type", ""))
    image_tokens = tokens(image_path.stem)
    wanted_region = region_expected_words(entry)
    score = 0
    score += 18 * len((name_tokens | color_tokens) & image_tokens)
    score += 12 * len(type_tokens & image_tokens)
    if any(word in image_tokens for word in wanted_region):
        score += 45
    if "honeycomb" in name_tokens and "honeycomb" in image_tokens:
        score += 40
    if "padded" in name_tokens and "padded" in image_tokens:
        score += 25
    if "transparent" in name_tokens and "transparent" in image_tokens:
        score += 40
    if "metallic" in name_tokens and "metallic" in image_tokens:
        score += 35
    if "lilac" in name_tokens and "lilac" in image_tokens:
        score += 35
    if "earth" in name_tokens and "earth" in image_tokens:
        score += 35
    if "balloon" in name_tokens and "balloon" in image_tokens:
        score += 35
    if "royal" in color_tokens and "blue" in color_tokens and "blue" in image_tokens:
        score += 35
    if "pink" in color_tokens and "pink" in image_tokens:
        score += 25
    if "yellow" in color_tokens and "yellow" in image_tokens:
        score += 25
    if "black" in color_tokens and "black" in image_tokens:
        score += 20
    return score


def match_entries(entries, image_dir):
    images = sorted([path for path in image_dir.iterdir() if path.suffix.lower() in [".png", ".jpg", ".jpeg", ".webp"]])
    image_by_name = {image.name: image for image in images}
    rows = []
    used = set()
    for entry in entries:
        known_match = KNOWN_IMAGE_MATCHES.get(normalized_key(entry["fields"].get("Garment Name", "")))
        if known_match:
            image = image_by_name.get(known_match)
            if not image:
                raise RuntimeError(f"Known image match is missing: {known_match}")
            if image in used:
                raise RuntimeError(f"Known image match was already used: {known_match}")
            used.add(image)
            rows.append({"entry": entry, "image": image, "confidence": 100})
            continue

        candidates = sorted(
            [(score_match(entry, image), image) for image in images if image not in used],
            key=lambda item: item[0],
            reverse=True,
        )
        if not candidates:
            raise RuntimeError("No unmatched image files remain")
        best_score, best_image = candidates[0]
        used.add(best_image)
        rows.append({"entry": entry, "image": best_image, "confidence": min(100, best_score)})
    return rows


def post_multipart(url, image_path, raw_description, description, prompt):
    boundary = "----lucybulk" + uuid.uuid4().hex
    fields = {
        "rawDescription": raw_description,
        "description": json.dumps(description),
        "descriptionFileName": image_path.with_suffix(".txt").name,
        "prompt": prompt,
    }
    body = bytearray()
    for name, value in fields.items():
        body.extend(f"--{boundary}\r\n".encode())
        body.extend(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode())
        body.extend(str(value).encode("utf-8"))
        body.extend(b"\r\n")
    mime_type = mimetypes.guess_type(image_path.name)[0] or "application/octet-stream"
    body.extend(f"--{boundary}\r\n".encode())
    body.extend(f'Content-Disposition: form-data; name="image"; filename="{image_path.name}"\r\n'.encode())
    body.extend(f"Content-Type: {mime_type}\r\n\r\n".encode())
    body.extend(image_path.read_bytes())
    body.extend(b"\r\n")
    body.extend(f"--{boundary}--\r\n".encode())
    req = request.Request(url, data=bytes(body), method="POST")
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    with request.urlopen(req, timeout=120) as response:
        return json.loads(response.read().decode("utf-8"))


def main():
    parser = argparse.ArgumentParser(description="Bulk import Lucy wardrobe garments from a PDF and image folder.")
    parser.add_argument("--pdf", required=True)
    parser.add_argument("--images", required=True)
    parser.add_argument("--review-csv", default="bulk-wardrobe-review.csv")
    parser.add_argument("--api-base", default="http://localhost:3001")
    parser.add_argument("--upload", action="store_true")
    args = parser.parse_args()

    entries = extract_entries(Path(args.pdf))
    rows = match_entries(entries, Path(args.images))
    review_path = Path(args.review_csv)
    review_path.parent.mkdir(parents=True, exist_ok=True)
    with review_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=["status", "confidence", "garment_name", "worn_area", "matched_image"])
        writer.writeheader()
        for row in rows:
            writer.writerow({
                "status": "ready" if row["confidence"] >= 80 else "review",
                "confidence": row["confidence"],
                "garment_name": row["entry"]["fields"].get("Garment Name", ""),
                "worn_area": row["entry"]["fields"].get("Worn Area", ""),
                "matched_image": str(row["image"]),
            })

    print(f"Parsed {len(entries)} garments.")
    print(f"Wrote review CSV: {review_path}")
    if not args.upload:
        return

    uploaded = 0
    for row in rows:
        description = parse_description(row["entry"]["raw"])
        prompt = generate_prompt(description)
        try:
            result = post_multipart(
                args.api_base.rstrip("/") + "/api/wardrobe",
                row["image"],
                row["entry"]["raw"],
                description,
                prompt,
            )
        except error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            print(f"Upload failed for {description['display_name']}: {exc.code} {detail}", file=sys.stderr)
            continue
        uploaded += 1
        print(f"Uploaded {uploaded:02d}: {result['garment']['name']}")
    print(f"Uploaded {uploaded} garments.")


if __name__ == "__main__":
    main()
