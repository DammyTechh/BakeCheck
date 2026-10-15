/**
 * OpenAPI documentation modules.
 *
 * One file per route group. Controllers import the object they need and apply
 * a single composed decorator per route — see ../README.md for the rationale
 * and the conventions.
 */
export { AuthDocs } from './auth.docs';
export { SamplesDocs } from './samples.docs';
export { LaboratoriesDocs } from './laboratories.docs';
export { ReferenceDocs } from './reference.docs';
export { ImagesDocs } from './images.docs';
export { AnalysesDocs } from './analyses.docs';
export { FeedbackDocs } from './feedback.docs';
export { AiDocs } from './ai.docs';
export { HealthDocs } from './health.docs';
