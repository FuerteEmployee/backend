const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'bot-uploads',
    allowed_formats: ['jpg', 'png', 'jpeg', 'webp'],
  },
});

const upload = multer({ storage: storage });

// Expense receipts (used only by POST /api/expenses).
//
// Most employees claim from a phone, and the receipt they have is a photo of
// the bill -- which used to be refused, because only PDF/Word was accepted.
// Photos are now stored as Cloudinary IMAGES, so the link opens in any
// browser; HEIC (some phones' camera default, which browsers cannot show) is
// converted to JPG on upload. PDF/Word keep the exact 'raw' treatment they
// always had, so existing links and delivery settings are untouched.
const EXPENSE_IMAGE_FORMATS = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'];
const EXPENSE_FILE_FORMATS = ['pdf', 'doc', 'docx'];
const EXPENSE_MAX_BYTES = 5 * 1024 * 1024;

const fileExtension = (file) => (file.originalname || '').split('.').pop().toLowerCase();
const isImageReceipt = (file) =>
  EXPENSE_IMAGE_FORMATS.includes(fileExtension(file)) || /^image\//.test(file.mimetype || '');
const isHeicReceipt = (file) =>
  ['heic', 'heif'].includes(fileExtension(file)) || /^image\/hei[cf]/.test(file.mimetype || '');

const documentStorage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: async (req, file) => {
    const image = isImageReceipt(file);
    return {
      folder: 'bot-uploads/expense-documents',
      resource_type: image ? 'image' : 'raw',
      allowed_formats: image ? EXPENSE_IMAGE_FORMATS : EXPENSE_FILE_FORMATS,
      ...(isHeicReceipt(file) ? { format: 'jpg' } : {}),
      // A raw file's URL is its public_id, and Cloudinary is never told the
      // original filename -- so a PDF came back as ".../b2uhijqkxv" with no
      // extension, served as octet-stream, and downloaded on the admin's
      // machine as a file nothing would open. Naming it keeps the ".pdf".
      ...(!image ? { public_id: `receipt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${fileExtension(file)}` } : {}),
    };
  },
});

// fileSize makes multer stop a >5 MB upload with LIMIT_FILE_SIZE; the expense
// route turns that into a plain-language 400.
const uploadDocument = multer({ storage: documentStorage, limits: { fileSize: EXPENSE_MAX_BYTES } });

const idDocumentStorage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'bot-uploads/id-documents',
    resource_type: 'auto',
    allowed_formats: ['jpg', 'png', 'jpeg', 'webp', 'pdf'],
  },
});

const uploadIdDocument = multer({ storage: idDocumentStorage });

module.exports = { cloudinary, upload, uploadDocument, uploadIdDocument, EXPENSE_MAX_BYTES };
