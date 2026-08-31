/** A media file in the bucket, derived from its key. */
export interface Item {
  /** Full object key, e.g. "2022/08/29/IMG_1234.jpg". */
  key: string;
  /** Folder date as "YYYY-MM-DD". Sort key; never from EXIF. */
  date: string;
  /** Size in bytes as reported by ListObjectsV2. */
  bytes: number;
  kind: MediaKind;
}

export type MediaKind = "image" | "video";

/** One day's items. Sections are the unit of layout and windowing. */
export interface Section {
  /** "YYYY-MM-DD". */
  date: string;
  /** "Tue, 29 Aug 2022". */
  label: string;
  items: Item[];
}

/** Per-object metadata. Open-ended: SQLite import adds fields later. */
export interface PhotoMeta {
  w: number;
  h: number;
  [extra: string]: unknown;
}

export interface Creds {
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  sessionToken?: string;
  /** Optional. Enables translation and semantic suggestions. */
  googleApiKey?: string;
}
