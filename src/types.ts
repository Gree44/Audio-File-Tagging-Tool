export type TagType = "main" | "mandatory" | "optional";
export interface TagDef {
  id: string;
  name: string; // no spaces; written into comment
  type: TagType;
  parent?: string | null;
  amountRange?: { min: number; max: number } | null;
}
export interface TagsFile {
  version: number;
  tags: TagDef[];
}

export interface TrackMeta {
  path: string;
  fileName: string;
  title?: string;
  artists?: string[];
  genre?: string;
  comment: string;
  pictureDataUrl?: string | null;
  format?: string;
}

export interface Settings {
  showTitle: boolean;
  showAuthors: boolean;
  showGenre: boolean;
  showAlbum?: boolean;
  showComment?: boolean;
  instantPlayback: boolean;
}
