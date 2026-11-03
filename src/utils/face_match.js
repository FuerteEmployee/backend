// ─────────────────────────────────────────────────────────────────────────────
// Face check for app punches: does this selfie show the employee whose
// registered face (FaceProfile, enrolled at the face kiosk) is on file?
//
// The kiosk matches faces in Python with OpenCV (BOTLens engine.py). Registered
// faces are stored as OpenCV SFace vectors, so the check here must produce the
// SAME vectors from a photo, or a selfie could never be compared with them. This
// file therefore reproduces OpenCV's own pipeline step for step, with the same
// two model files, run by onnxruntime instead of OpenCV:
//
//   1. YuNet finds faces and 5 landmarks (eyes, nose tip, mouth corners).
//   2. The face is aligned to SFace's 112x112 template by a similarity
//      transform of those landmarks (OpenCV FaceRecognizerSF::alignCrop).
//   3. SFace turns the aligned face into 128 numbers (::feature).
//   4. The person is scored like the kiosk scores them (person_score) and the
//      kiosk's threshold decides.
//
// onnxruntime-node is pinned to 1.20.1: 1.22 and 1.30 crash the whole process
// (access violation) when loading a model on Windows.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Same numbers as BOTLens engine.py, so the app and the kiosk agree on who
// someone is. Tuned there on the registered faces (12 Oct): 0.45 took an
// unregistered person being taken for someone else from 3 in 6 to 0.
const MATCH_THRESHOLD = Number(process.env.FACE_MATCH_THRESHOLD) || 0.45;
const DET_SIZE = 640;          // YuNet 2023mar takes a fixed 640x640 input
const DET_SCORE = 0.6;         // FaceDetectorYN score threshold (as the kiosk)
const DET_NMS = 0.3;
const MAX_SIDE = 1280;         // engine.py encode_photo: big photos are shrunk first

const MODELS_DIR = process.env.FACE_MODELS_DIR || path.join(__dirname, '..', '..', 'models');
// The official OpenCV model zoo files, byte-identical to the kiosk's own copies.
// Downloaded on first use rather than committed: SFace is 38 MB.
const MODELS = {
    det: {
        file: 'face_detection_yunet_2023mar.onnx',
        url: 'https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx',
        sha256: '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4',
    },
    rec: {
        file: 'face_recognition_sface_2021dec.onnx',
        url: 'https://github.com/opencv/opencv_zoo/raw/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx',
        sha256: '0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79',
    },
};

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function modelBytes({ file, url, sha256: expected }) {
    const p = path.join(MODELS_DIR, file);
    if (fs.existsSync(p)) {
        const buf = fs.readFileSync(p);
        if (sha256(buf) === expected) return buf;
        console.warn(`[face] ${file} on disk does not match its checksum; downloading again.`);
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`could not download ${file}: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (sha256(buf) !== expected) throw new Error(`downloaded ${file} does not match its checksum`);
    fs.mkdirSync(MODELS_DIR, { recursive: true });
    fs.writeFileSync(p, buf);
    console.log(`[face] downloaded ${file} (${Math.round(buf.length / 1024)} KB)`);
    return buf;
}

let enginePromise = null;
function engine() {
    if (!enginePromise) {
        enginePromise = (async () => {
            const ort = require('onnxruntime-node');
            const opts = { logSeverityLevel: 3 }; // SFace warns about initializers on every load
            const [detBuf, recBuf] = await Promise.all([modelBytes(MODELS.det), modelBytes(MODELS.rec)]);
            const [det, rec] = await Promise.all([
                ort.InferenceSession.create(detBuf, opts),
                ort.InferenceSession.create(recBuf, opts),
            ]);
            return { ort, det, rec };
        })().catch((err) => {
            enginePromise = null; // let the next punch try again
            throw err;
        });
    }
    return enginePromise;
}

/** Photo bytes -> RGB pixels, upright, at most MAX_SIDE on the long edge. */
async function decode(buffer) {
    const sharp = require('sharp');
    const { data, info } = await sharp(buffer)
        .rotate() // phone photos carry their orientation in EXIF
        .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    return { rgb: data, w: info.width, h: info.height };
}

function iou(a, b) {
    const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
    const x2 = Math.min(a[0] + a[2], b[0] + b[2]), y2 = Math.min(a[1] + a[3], b[1] + b[3]);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    return inter / (a[2] * a[3] + b[2] * b[3] - inter || 1);
}

/**
 * All faces in the image, as OpenCV's FaceDetectorYN rows:
 * [x, y, w, h, 5 x (lx, ly), score], in the image's own pixels.
 */
async function detect(img) {
    const sharp = require('sharp');
    const { ort, det } = await engine();
    const s = DET_SIZE / Math.max(img.w, img.h);
    const dw = Math.max(1, Math.round(img.w * s)), dh = Math.max(1, Math.round(img.h * s));
    const small = img.w === dw && img.h === dh ? img.rgb : await sharp(img.rgb, { raw: { width: img.w, height: img.h, channels: 3 } })
        .resize(dw, dh, { kernel: 'linear' }).raw().toBuffer();

    // OpenCV feeds YuNet BGR, 0-255, unnormalised, padded with zeros at the
    // right and bottom -- placing the image top-left keeps its coordinates.
    const plane = DET_SIZE * DET_SIZE;
    const input = new Float32Array(3 * plane);
    for (let y = 0; y < dh; y++) {
        for (let x = 0; x < dw; x++) {
            const i = (y * dw + x) * 3, o = y * DET_SIZE + x;
            input[o] = small[i + 2];             // B
            input[plane + o] = small[i + 1];     // G
            input[2 * plane + o] = small[i];     // R
        }
    }
    const out = await det.run({ [det.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, DET_SIZE, DET_SIZE]) });

    // Decoding exactly as OpenCV's FaceDetectorYN (face_detect.cpp, 2023 model).
    const faces = [];
    for (const stride of [8, 16, 32]) {
        const cls = out[`cls_${stride}`].data, obj = out[`obj_${stride}`].data;
        const bbox = out[`bbox_${stride}`].data, kps = out[`kps_${stride}`].data;
        const cols = DET_SIZE / stride, rows = DET_SIZE / stride;
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const idx = r * cols + c;
                const score = Math.sqrt(Math.min(1, Math.max(0, cls[idx])) * Math.min(1, Math.max(0, obj[idx])));
                if (score < DET_SCORE) continue;
                const cx = (c + bbox[idx * 4]) * stride, cy = (r + bbox[idx * 4 + 1]) * stride;
                const w = Math.exp(bbox[idx * 4 + 2]) * stride, h = Math.exp(bbox[idx * 4 + 3]) * stride;
                const row = [cx - w / 2, cy - h / 2, w, h];
                for (let n = 0; n < 5; n++) {
                    row.push((kps[idx * 10 + 2 * n] + c) * stride, (kps[idx * 10 + 2 * n + 1] + r) * stride);
                }
                row.push(score);
                faces.push(row);
            }
        }
    }
    faces.sort((a, b) => b[14] - a[14]);
    const kept = [];
    for (const f of faces) if (kept.every((k) => iou(k, f) <= DET_NMS)) kept.push(f);
    // Back to the image's own pixels.
    return kept
        .map((f) => f.map((v, i) => (i < 14 ? v / s : v)))
        .filter((f) => f.slice(0, 15).every(Number.isFinite));
}

// SFace's 112x112 landmark template (OpenCV face_recognize.cpp).
const TEMPLATE = [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]];

/**
 * The 2x3 similarity transform taking the 5 landmarks onto the template:
 * least-squares rotation + uniform scale + translation (the Umeyama estimate
 * OpenCV's getSimilarityTransformMatrix computes, without reflection).
 */
function similarityTransform(points) {
    const n = points.length;
    let sx = 0, sy = 0, dx = 0, dy = 0;
    for (let i = 0; i < n; i++) { sx += points[i][0]; sy += points[i][1]; dx += TEMPLATE[i][0]; dy += TEMPLATE[i][1]; }
    sx /= n; sy /= n; dx /= n; dy /= n;
    let num1 = 0, num2 = 0, den = 0;
    for (let i = 0; i < n; i++) {
        const px = points[i][0] - sx, py = points[i][1] - sy;
        const qx = TEMPLATE[i][0] - dx, qy = TEMPLATE[i][1] - dy;
        num1 += px * qx + py * qy;
        num2 += px * qy - py * qx;
        den += px * px + py * py;
    }
    const a = num1 / den, b = num2 / den; // [[a,-b],[b,a]] = scale * rotation
    return [a, -b, dx - (a * sx - b * sy), b, a, dy - (b * sx + a * sy)];
}

/** OpenCV warpAffine(..., Size(112,112), INTER_LINEAR, BORDER_CONSTANT 0), RGB planar. */
function alignCrop(img, face) {
    const pts = [0, 1, 2, 3, 4].map((k) => [face[4 + 2 * k], face[5 + 2 * k]]);
    const [m00, m01, m02, m10, m11, m12] = similarityTransform(pts);
    // Invert the 2x3 affine: each output pixel looks up its source.
    const det = m00 * m11 - m01 * m10;
    const i00 = m11 / det, i01 = -m01 / det, i10 = -m10 / det, i11 = m00 / det;
    const i02 = -(i00 * m02 + i01 * m12), i12 = -(i10 * m02 + i11 * m12);
    const S = 112, plane = S * S;
    const out = new Float32Array(3 * plane);
    const { rgb, w, h } = img;
    const px = (x, y, ch) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : rgb[(y * w + x) * 3 + ch]);
    for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
            const fx = i00 * x + i01 * y + i02, fy = i10 * x + i11 * y + i12;
            const x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0;
            for (let ch = 0; ch < 3; ch++) {
                const v = (1 - ax) * (1 - ay) * px(x0, y0, ch) + ax * (1 - ay) * px(x0 + 1, y0, ch)
                    + (1 - ax) * ay * px(x0, y0 + 1, ch) + ax * ay * px(x0 + 1, y0 + 1, ch);
                // SFace's blob is RGB (blobFromImage swapRB=true on a BGR crop).
                out[ch * plane + y * S + x] = v;
            }
        }
    }
    return out;
}

async function embed(img, face) {
    const { ort, rec } = await engine();
    const input = alignCrop(img, face);
    const out = await rec.run({ [rec.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, 112, 112]) });
    return Array.from(out[rec.outputNames[0]].data);
}

/** OpenCV FaceRecognizerSF::match(..., FR_COSINE). */
function cosine(a, b) {
    let ab = 0, aa = 0, bb = 0;
    for (let i = 0; i < a.length; i++) { ab += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
    return ab / (Math.sqrt(aa) * Math.sqrt(bb) || 1);
}

/**
 * engine.py person_score: the first registered angle is straight-on and counts
 * for half; the best of all angles counts for the other half.
 */
function personScore(vector, registered) {
    if (!registered?.length) return -1;
    const scores = registered.map((t) => cosine(vector, t));
    return 0.5 * scores[0] + 0.5 * Math.max(...scores);
}

/** One photo -> the SFace vector of its largest face, or null when none is found. */
async function photoVector(buffer) {
    const img = await decode(buffer);
    const faces = await detect(img);
    if (!faces.length) return { vector: null, faces: 0 };
    const largest = faces.reduce((a, b) => (b[2] * b[3] > a[2] * a[3] ? b : a));
    return { vector: await embed(img, largest), faces: faces.length, box: largest.slice(0, 4).map(Math.round) };
}

/**
 * Does `photo` (a data: URL or bytes) show the person whose registered angles
 * are `registered`?
 *
 * @returns {Promise<{result: 'match'|'mismatch'|'no_face', score: number|null, faces: number}>}
 *   Throws only when the face engine itself cannot run (models missing, bad
 *   image); the caller decides what that means for the punch.
 */
async function checkFace(photo, registered) {
    const buffer = Buffer.isBuffer(photo)
        ? photo
        : Buffer.from(String(photo).replace(/^data:image\/[a-z]+;base64,/i, ''), 'base64');
    const { vector, faces } = await photoVector(buffer);
    if (!vector) return { result: 'no_face', score: null, faces: 0 };
    const score = personScore(vector, registered);
    return { result: score >= MATCH_THRESHOLD ? 'match' : 'mismatch', score: Math.round(score * 1000) / 1000, faces };
}

/** Load the models now (at boot) instead of on the first punch. */
function warmUp() {
    return engine().then(() => true);
}

module.exports = { checkFace, photoVector, personScore, cosine, similarityTransform, warmUp, MATCH_THRESHOLD };
