// src/services/cloudinary.js
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary'); // ← destructuring correcto
const multer = require('multer');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ── REGLAS DE MEDIA ──────────────────────────────────────────
const MEDIA_RULES = {
  video: {
    '720p': {
      max_duration_seconds: 60,
      max_size_mb: 100,
      folder: 'retog/videos/hd',
    },
    '480p': {
      max_duration_seconds: 120,
      max_size_mb: 100,
      folder: 'retog/videos/sd',
    },
  },
  photo: {
    max_size_mb: 10,
    folder: 'retog/photos',
  },
  avatar: {
    max_size_mb: 5,
    folder: 'retog/avatars',
  },
};

const MAX_BYTES = (mb) => mb * 1024 * 1024;

// ── PHOTO STORAGE ────────────────────────────────────────────
const photoStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder:          MEDIA_RULES.photo.folder,
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp', 'heic'],
    transformation:  [
      { width: 1080, height: 1080, crop: 'limit' },
      { quality: 'auto:good' },
      { fetch_format: 'webp' },
    ],
    resource_type: 'image',
  },
});

// ── AVATAR STORAGE ───────────────────────────────────────────
const avatarStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder:          MEDIA_RULES.avatar.folder,
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
    transformation:  [
      { width: 400, height: 400, crop: 'fill', gravity: 'face' },
      { quality: 'auto:good' },
      { fetch_format: 'webp' },
    ],
    resource_type: 'image',
  },
});

// ── VIDEO STORAGE 720p ───────────────────────────────────────
const videoStorage720p = new CloudinaryStorage({
  cloudinary,
  params: {
    folder:          MEDIA_RULES.video['720p'].folder,
    allowed_formats: ['mp4', 'mov', 'avi', 'webm'],
    resource_type:   'video',
    // Sin transformación síncrona — Cloudinary procesa en background
  },
});

// ── VIDEO STORAGE 480p ───────────────────────────────────────
const videoStorage480p = new CloudinaryStorage({
  cloudinary,
  params: {
    folder:          MEDIA_RULES.video['480p'].folder,
    allowed_formats: ['mp4', 'mov', 'avi', 'webm'],
    resource_type:   'video',
  },
});
// ── MULTER UPLOADERS ─────────────────────────────────────────
const uploadPhoto = multer({
  storage: photoStorage,
  limits:  { fileSize: MAX_BYTES(MEDIA_RULES.photo.max_size_mb) },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Solo se permiten imágenes'), false);
    }
    cb(null, true);
  },
});

const uploadAvatar = multer({
  storage: avatarStorage,
  limits:  { fileSize: MAX_BYTES(MEDIA_RULES.avatar.max_size_mb) },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Solo se permiten imágenes para avatar'), false);
    }
    cb(null, true);
  },
});

const uploadVideo720p = multer({
  storage: videoStorage720p,
  limits:  { fileSize: MAX_BYTES(MEDIA_RULES.video['720p'].max_size_mb) },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('video/')) {
      return cb(new Error('Solo se permiten videos'), false);
    }
    cb(null, true);
  },
});

const uploadVideo480p = multer({
  storage: videoStorage480p,
  limits:  { fileSize: MAX_BYTES(MEDIA_RULES.video['480p'].max_size_mb) },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('video/')) {
      return cb(new Error('Solo se permiten videos'), false);
    }
    cb(null, true);
  },
});

// ── HELPER: Eliminar de Cloudinary ───────────────────────────
const deleteMedia = async (cloudinaryId, resourceType = 'image') => {
  try {
    return await cloudinary.uploader.destroy(cloudinaryId, {
      resource_type: resourceType,
    });
  } catch (err) {
    console.error('Error eliminando media de Cloudinary:', err);
    throw err;
  }
};

// ── HELPER: Duración del video ───────────────────────────────
const getVideoDuration = (file) => {
  if (file.cloudinaryMetadata?.duration) {
    return Math.round(file.cloudinaryMetadata.duration);
  }
  return null;
};

// ── MIDDLEWARE: Validar duración post-upload ─────────────────
const validateVideoDuration = (quality) => async (req, res, next) => {
  if (!req.file) return next();

  const maxDuration = MEDIA_RULES.video[quality].max_duration_seconds;
  const duration    = getVideoDuration(req.file);

  if (duration && duration > maxDuration) {
    await deleteMedia(req.file.filename, 'video').catch(console.error);
    return res.status(400).json({
      error:       `El video excede el límite de ${maxDuration} segundos para ${quality}`,
      max_seconds: maxDuration,
      your_seconds: duration,
    });
  }

  req.videoDuration = duration;
  next();
};

module.exports = {
  cloudinary,
  uploadPhoto,
  uploadAvatar,
  uploadVideo720p,
  uploadVideo480p,
  deleteMedia,
  getVideoDuration,
  validateVideoDuration,
  MEDIA_RULES,
};