/**
 * The uploaded-file shape, declared locally.
 *
 * multer 2.x ships no type declarations, and `@types/multer` describes the
 * 1.x API — which this project deliberately does not use, because multer 1.x
 * carries unpatched DoS advisories (see docs/adr/0001-nestjs-11-commonjs.md).
 *
 * Rather than install types that describe a different major version, this
 * declares only the fields the upload path actually reads. Everything here is
 * attacker-controlled except `buffer.length`:
 *
 *   • `mimetype` is whatever the client claimed. The real format is
 *     determined by inspecting the file signature in ImageValidationService.
 *   • `originalname` is arbitrary client text; it is sanitised to a basename
 *     before being stored or logged.
 *
 * `memoryStorage` is used (Nest's default for FileInterceptor), so `buffer`
 * is always present and nothing is written to a temporary path that would
 * need cleaning up.
 */
export interface UploadedFile {
  /** Form field name the file arrived under. */
  fieldname: string;

  /** Client-supplied filename. Untrusted; sanitised before use. */
  originalname: string;

  encoding: string;

  /** Client-declared content type. Advisory only — never trusted. */
  mimetype: string;

  /** Byte length, as measured by the server. */
  size: number;

  /** The file contents. Present because memory storage is in use. */
  buffer: Buffer;
}
