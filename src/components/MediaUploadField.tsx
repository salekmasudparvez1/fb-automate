import React, { useRef, useState } from 'react';
import {
  AlertTriangle,
  Film,
  Image as ImageIcon,
  Link as LinkIcon,
  Loader2,
  Trash2,
  Type as TypeIcon,
  UploadCloud,
} from 'lucide-react';
import type { MediaType } from '../types';

interface MediaUploadFieldProps {
  mediaType: MediaType;
  mediaUrl: string;
  mediaPublicId?: string;
  cloudinaryConfigured: boolean;
  apiFetch: <T>(url: string, options?: RequestInit) => Promise<T>;
  onChange: (next: {
    mediaType: MediaType;
    mediaUrl: string;
    mediaPublicId?: string;
  }) => void;
}

interface CloudinarySignatureResponse {
  cloudName: string;
  apiKey: string;
  timestamp: number;
  folder: string;
  signature: string;
  resourceType: 'image' | 'video';
}

export const MediaUploadField: React.FC<MediaUploadFieldProps> = ({
  mediaType,
  mediaUrl,
  mediaPublicId,
  cloudinaryConfigured,
  apiFetch,
  onChange,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [previewBroken, setPreviewBroken] = useState(false);

  const handleSelectMode = (nextMode: MediaType) => {
    setUploadError(null);
    setPreviewBroken(false);
    if (nextMode === 'none') {
      onChange({ mediaType: 'none', mediaUrl: '', mediaPublicId: undefined });
    } else {
      onChange({ mediaType: nextMode, mediaUrl, mediaPublicId });
    }
  };

  const handleFileUpload = async (file: File) => {
    setUploadError(null);
    setPreviewBroken(false);

    const isVideoFile = file.type.startsWith('video/');
    const isImageFile = file.type.startsWith('image/');
    if (!isImageFile && !isVideoFile) {
      setUploadError('Please select a valid image (JPG, PNG, WEBP) or video (MP4, MOV, WEBM).');
      return;
    }

    const resourceType: 'image' | 'video' = isVideoFile ? 'video' : 'image';
    setIsUploading(true);
    try {
      const sig = await apiFetch<CloudinarySignatureResponse>('/api/media/signature', {
        method: 'POST',
        body: JSON.stringify({ resourceType }),
      });

      const formData = new FormData();
      formData.append('file', file);
      formData.append('api_key', sig.apiKey);
      formData.append('timestamp', String(sig.timestamp));
      formData.append('folder', sig.folder);
      formData.append('signature', sig.signature);

      const uploadRes = await fetch(
        `https://api.cloudinary.com/v1_1/${encodeURIComponent(sig.cloudName)}/${resourceType}/upload`,
        {
          method: 'POST',
          body: formData,
        }
      );

      const uploadJson = (await uploadRes.json().catch(() => ({}))) as {
        secure_url?: string;
        public_id?: string;
        error?: { message?: string };
      };

      if (!uploadRes.ok || !uploadJson.secure_url) {
        throw new Error(
          uploadJson.error?.message || `Cloudinary upload failed (HTTP ${uploadRes.status}).`
        );
      }

      onChange({
        mediaType: resourceType,
        mediaUrl: uploadJson.secure_url,
        mediaPublicId: uploadJson.public_id,
      });
    } catch (err: unknown) {
      setUploadError(
        err instanceof Error ? err.message : 'Failed to upload media to Cloudinary.'
      );
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  return (
    <div className="space-y-2.5 p-3 bg-[#F7F8FA] border border-[#E4E6EB] rounded-xl">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-semibold text-[#1C1E21]">
          Media Attachment (Cloudinary / URL)
        </span>
        <div className="inline-flex items-center gap-1 p-0.5 bg-white border border-[#CCD0D5] rounded-lg">
          {(
            [
              { id: 'none', label: 'Text Only', Icon: TypeIcon },
              { id: 'image', label: 'Image', Icon: ImageIcon },
              { id: 'video', label: 'Video', Icon: Film },
            ] as const
          ).map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => handleSelectMode(id)}
              className={`inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                mediaType === id
                  ? 'bg-[#1877F2] text-white font-semibold'
                  : 'text-[#65676B] hover:text-[#1C1E21]'
              }`}
            >
              <Icon className="w-3 h-3" />
              <span>{label}</span>
            </button>
          ))}
        </div>
      </div>

      {mediaType !== 'none' && (
        <div className="space-y-2.5">
          {/* Cloudinary Signed Direct Upload */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept={mediaType === 'video' ? 'video/*' : 'image/*'}
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFileUpload(file);
              }}
            />

            <button
              type="button"
              disabled={isUploading || !cloudinaryConfigured}
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold text-[#1C1E21] bg-white hover:bg-[#F0F2F5] border border-[#CCD0D5] disabled:opacity-50 rounded-lg whitespace-nowrap cursor-pointer"
            >
              {isUploading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-[#1877F2]" />
              ) : (
                <UploadCloud className="w-3.5 h-3.5 text-[#1877F2]" />
              )}
              <span>
                {isUploading
                  ? 'Uploading to Cloudinary...'
                  : mediaType === 'video'
                    ? 'Upload Video'
                    : 'Upload Image'}
              </span>
            </button>

            <div className="relative flex-1 min-w-0">
              <LinkIcon className="w-3.5 h-3.5 text-[#65676B] absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="url"
                value={mediaUrl}
                onChange={(e) => {
                  setPreviewBroken(false);
                  onChange({
                    mediaType,
                    mediaUrl: e.target.value,
                    mediaPublicId: undefined,
                  });
                }}
                placeholder={
                  mediaType === 'video'
                    ? 'https://res.cloudinary.com/.../video.mp4'
                    : 'https://res.cloudinary.com/.../image.jpg'
                }
                className="w-full pl-8 pr-8 py-2 text-xs font-mono bg-white border border-[#CCD0D5] rounded-lg focus:outline-none focus:border-[#1877F2]"
              />
              {mediaUrl && (
                <button
                  type="button"
                  onClick={() =>
                    onChange({ mediaType: 'none', mediaUrl: '', mediaPublicId: undefined })
                  }
                  title="Remove media"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-[#65676B] hover:text-red-700 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>

          {!cloudinaryConfigured && (
            <p className="text-[11px] text-amber-800">
              Direct file uploads require{' '}
              <span className="font-mono">CLOUDINARY_CLOUD_NAME</span>,{' '}
              <span className="font-mono">CLOUDINARY_API_KEY</span>, and{' '}
              <span className="font-mono">CLOUDINARY_API_SECRET</span> in Secrets (or paste any direct HTTPS media URL above).
            </p>
          )}

          {uploadError && (
            <div className="flex items-start gap-2 p-2 text-xs text-red-800 bg-red-50 border border-red-200 rounded-lg">
              <AlertTriangle className="w-3.5 h-3.5 text-red-600 shrink-0 mt-0.5" />
              <span>{uploadError}</span>
            </div>
          )}

          {mediaUrl && !previewBroken && (
            <div className="rounded-lg overflow-hidden border border-[#E4E6EB] bg-black/5 max-h-48 flex items-center justify-center">
              {mediaType === 'video' ? (
                <video
                  src={mediaUrl}
                  controls
                  preload="metadata"
                  onError={() => setPreviewBroken(true)}
                  className="w-full max-h-48 object-contain bg-black"
                />
              ) : (
                <img
                  src={mediaUrl}
                  alt="Post attachment preview"
                  referrerPolicy="no-referrer"
                  onError={() => setPreviewBroken(true)}
                  className="w-full max-h-48 object-contain"
                />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
