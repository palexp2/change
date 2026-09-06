import multer from 'multer'
import { randomUUID } from 'node:crypto'
import { extname } from 'node:path'
import { UPLOAD_PARAM_CHARSET } from './uploadFileName.js'

const defaultFilename = (req, file) => `${randomUUID()}${extname(file.originalname).toLowerCase()}`

export function makeUpload({ destination, filename = defaultFilename, fileSize, allowedExt, rejectMessage }) {
  const opts = {
    defParamCharset: UPLOAD_PARAM_CHARSET,
    storage: multer.diskStorage({
      destination,
      filename: (req, file, cb) => cb(null, filename(req, file)),
    }),
  }
  if (fileSize) opts.limits = { fileSize }
  if (allowedExt) {
    opts.fileFilter = (req, file, cb) => {
      const ext = extname(file.originalname).toLowerCase()
      if (allowedExt.includes(ext)) cb(null, true)
      else cb(new Error(rejectMessage(ext)))
    }
  }
  return multer(opts)
}
