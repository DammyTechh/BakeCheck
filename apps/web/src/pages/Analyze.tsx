/**
 * Register a sample, attach a photograph, read the result.
 *
 * Kept as one screen with three steps rather than three routes: a technician
 * does this with a tube in one hand, and losing the sample code because a
 * page navigated is a bad trade for tidier URLs.
 *
 * The capture guidance is not filler. Every photograph the laboratory has
 * sent so far carried a `missing_calibration` warning because there was no
 * grey card in frame, and the first four were nearly rejected outright for
 * focus. Saying so here costs one short list and saves a retake.
 */
import { useRef, useState, type ChangeEvent, type DragEvent, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { Analysis, Sample, SampleImage as SampleImageType, TestMethod } from '../lib/types';
import { PageHead } from '../components/AppShell';
import {
  Banner,
  Button,
  EmptyState,
  Field,
  Icon,
  Input,
  Panel,
  Select,
  Spinner,
  Textarea,
} from '../components/ui';
import { formatBytes } from '../lib/format';
import './Analyze.css';

const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_BYTES = 10 * 1024 * 1024;

const CAPTURE_TIPS = [
  'Hold the tube against a plain, evenly lit background.',
  'Include a white or grey card in the frame so lighting can be corrected.',
  'Fill the frame with the tube and keep it in focus.',
  'Avoid direct glare on the glass.',
];

export function Analyze() {
  const navigate = useNavigate();
  const { laboratory } = useAuth();

  const [sampleCode, setSampleCode] = useState('');
  const [productName, setProductName] = useState('');
  const [batchReference, setBatchReference] = useState('');
  const [notes, setNotes] = useState('');
  const [methodId, setMethodId] = useState('');

  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const inputRef = useRef<HTMLInputElement>(null);

  const methods = useQuery({
    queryKey: ['test-methods'],
    queryFn: () => api.get<TestMethod[] | { data: TestMethod[] }>('/test-methods'),
    select: (raw) => (Array.isArray(raw) ? raw : raw.data),
  });

  const activeMethod =
    methods.data?.find((m) => m.id === methodId) ?? methods.data?.[0] ?? null;

  function acceptFile(next: File | null) {
    setFileError(null);
    if (!next) return;

    if (!ACCEPTED.includes(next.type)) {
      setFileError('Use a JPEG, PNG or WebP image.');
      return;
    }
    if (next.size > MAX_BYTES) {
      setFileError(`That file is ${formatBytes(next.size)}. The limit is 10 MB.`);
      return;
    }

    setFile(next);
    setPreview((old) => {
      if (old) URL.revokeObjectURL(old);
      return URL.createObjectURL(next);
    });
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    acceptFile(event.dataTransfer.files[0] ?? null);
  }

  const run = useMutation({
    mutationFn: async (): Promise<Analysis> => {
      // Three calls, in order: the sample must exist before an image can
      // hang off it, and the image before it can be analysed.
      const sample = await api.post<Sample>('/samples', {
        laboratoryId: laboratory!.laboratoryId,
        sampleCode: sampleCode.trim(),
        sampleType: 'bread',
        testMethodId: activeMethod?.id,
        ...(productName.trim() ? { productName: productName.trim() } : {}),
        ...(batchReference.trim() ? { batchReference: batchReference.trim() } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      });

      const body = new FormData();
      body.append('file', file!);
      body.append('source', 'CAMERA');
      const image = await api.upload<SampleImageType>(`/samples/${sample.id}/images`, body);

      return api.post<Analysis>(`/samples/${sample.id}/analyze`, {
        imageId: image.id,
      });
    },
    onSuccess: (analysis) => navigate(`/analyses/${analysis.id}`),
    onError: (error) => {
      if (error instanceof ApiError) {
        const fields = error.fieldErrors();
        if (Object.keys(fields).length > 0) {
          setFieldErrors(fields);
          setFormError(null);
          return;
        }
        setFormError(
          error.code === 'ALREADY_EXISTS'
            ? 'A sample with that code already exists in this laboratory. Use a different code.'
            : error.message,
        );
        return;
      }
      setFormError('The analysis could not be started.');
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    setFieldErrors({});

    if (!sampleCode.trim()) {
      setFieldErrors({ sampleCode: 'Give the sample a code so it can be found again.' });
      return;
    }
    if (!file) {
      setFileError('Add a photograph of the developed tube.');
      return;
    }
    run.mutate();
  }

  if (!laboratory) {
    return (
      <>
        <PageHead title="Analyse a sample" />
        <Panel>
          <EmptyState icon="apartment" title="You are not in a laboratory yet">
            Every sample belongs to a laboratory. Ask your laboratory
            administrator to add you, then come back to this page.
          </EmptyState>
        </Panel>
      </>
    );
  }

  return (
    <>
      <PageHead
        title="Analyse a sample"
        description="Register the sample, attach a photograph of the developed tube, and BakeCheck will measure its colour."
      />

      <form onSubmit={onSubmit} noValidate>
        <div className="split">
          <div className="stack-lg">
            <Panel title="Photograph">
              <div
                className={`drop ${dragging ? 'is-dragging' : ''} ${
                  fileError ? 'is-invalid' : ''
                }`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
              >
                {preview ? (
                  <div className="drop-preview">
                    <img src={preview} alt="The photograph you selected" />
                    <div className="drop-preview-meta">
                      <span className="mono">{file?.name}</span>
                      <span className="drop-preview-size">
                        {file ? formatBytes(file.size) : ''}
                      </span>
                      <Button
                        size="sm"
                        variant="quiet"
                        icon="close"
                        type="button"
                        onClick={() => {
                          setFile(null);
                          setPreview((old) => {
                            if (old) URL.revokeObjectURL(old);
                            return null;
                          });
                          if (inputRef.current) inputRef.current.value = '';
                        }}
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="drop-empty">
                    <Icon name="add_a_photo" className="icon-lg drop-icon" />
                    <p className="drop-title">Drop a photograph here</p>
                    <p className="drop-sub">JPEG, PNG or WebP, up to 10 MB</p>
                    <Button
                      type="button"
                      onClick={() => inputRef.current?.click()}
                      icon="upload"
                    >
                      Choose a file
                    </Button>
                  </div>
                )}

                <input
                  ref={inputRef}
                  type="file"
                  accept={ACCEPTED.join(',')}
                  className="sr-only"
                  // capture hints a phone towards its camera without blocking
                  // a laptop from picking an existing file.
                  capture="environment"
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    acceptFile(e.target.files?.[0] ?? null)
                  }
                />
              </div>

              {fileError ? (
                <p className="field-error" role="alert">
                  <Icon name="error" className="icon-sm" />
                  {fileError}
                </p>
              ) : null}
            </Panel>

            <Panel title="Sample">
              <Field
                label="Sample code"
                htmlFor="sampleCode"
                hint="Unique within your laboratory."
                error={fieldErrors.sampleCode}
              >
                <Input
                  id="sampleCode"
                  className="mono"
                  required
                  value={sampleCode}
                  onChange={(e) => setSampleCode(e.target.value)}
                  placeholder="BRD-2026-014"
                  invalid={Boolean(fieldErrors.sampleCode)}
                />
              </Field>

              <div className="field-row">
                <Field label="Product name" htmlFor="productName" error={fieldErrors.productName}>
                  <Input
                    id="productName"
                    value={productName}
                    onChange={(e) => setProductName(e.target.value)}
                    placeholder="Sliced white loaf"
                  />
                </Field>
                <Field label="Batch reference" htmlFor="batchReference">
                  <Input
                    id="batchReference"
                    className="mono"
                    value={batchReference}
                    onChange={(e) => setBatchReference(e.target.value)}
                  />
                </Field>
              </div>

              {methods.data && methods.data.length > 1 ? (
                <Field label="Test method" htmlFor="method">
                  <Select
                    id="method"
                    value={activeMethod?.id ?? ''}
                    onChange={(e) => setMethodId(e.target.value)}
                  >
                    {methods.data.map((method) => (
                      <option key={method.id} value={method.id}>
                        {method.name} ({method.methodVersion})
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : null}

              <Field label="Notes" htmlFor="notes" hint="Optional.">
                <Textarea
                  id="notes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Preparation, dilution, anything unusual about the sample."
                />
              </Field>
            </Panel>

            {formError ? <Banner tone="stop" icon="error">{formError}</Banner> : null}

            <div className="row">
              <Button type="submit" variant="primary" loading={run.isPending} icon="science">
                {run.isPending ? 'Analysing…' : 'Analyse sample'}
              </Button>
              {run.isPending ? (
                <span className="muted">Measuring the colour. This takes a moment.</span>
              ) : null}
            </div>
          </div>

          <div className="stack-lg">
            <Panel title="Taking a good photograph">
              <ul className="tips">
                {CAPTURE_TIPS.map((tip) => (
                  <li key={tip}>
                    <Icon name="check" className="icon-sm tips-icon" />
                    <span>{tip}</span>
                  </li>
                ))}
              </ul>
            </Panel>

            {methods.isLoading ? (
              <Spinner label="Loading test methods…" />
            ) : activeMethod && activeMethod.validationStatus !== 'VALIDATED' ? (
              <Banner tone="caution" icon="warning" title="Screening only">
                <p>
                  {activeMethod.name} is at validation status{' '}
                  <strong>{activeMethod.validationStatus}</strong>. Results will
                  name a colour band rather than a bromate concentration, and
                  must be confirmed by laboratory analysis.
                </p>
              </Banner>
            ) : null}
          </div>
        </div>
      </form>
    </>
  );
}
