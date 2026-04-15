/**
 * Type shim for @openparachute/core/do.
 *
 * The upstream `@openparachute/core` package ships raw `.ts` sources (no
 * `.d.ts`), and its relaxed tsconfig doesn't satisfy our stricter one. Until
 * upstream publishes typed output, we redirect type resolution to this shim
 * via tsconfig `paths`. The runtime bundler still resolves the real module.
 *
 * TODO: delete once `@openparachute/core` publishes `.d.ts` + a stable API.
 */

declare module "@openparachute/core/do" {
  export interface VaultStatsSummary {
    totalNotes: number;
    [k: string]: unknown;
  }

  export interface NoteLike {
    id: string;
    content: string;
    path?: string;
    metadata?: Record<string, unknown>;
    createdAt: string;
    updatedAt?: string;
    tags?: string[];
  }

  export interface QueryOptsLike {
    tags?: string[];
    tagMatch?: "all" | "any";
    excludeTags?: string[];
    path?: string;
    pathPrefix?: string;
    dateFrom?: string;
    dateTo?: string;
    sort?: "asc" | "desc";
    limit?: number;
    offset?: number;
  }

  export class DoSqliteStore {
    constructor(
      storage: { sql: unknown; transactionSync: <T>(fn: () => T) => T },
      opts?: { hooks?: unknown; blobStore?: unknown },
    );

    createNote(
      content: string,
      opts?: {
        id?: string;
        path?: string;
        tags?: string[];
        metadata?: Record<string, unknown>;
        created_at?: string;
      },
    ): Promise<NoteLike>;

    getNote(id: string): Promise<NoteLike | null>;
    getNoteByPath(path: string): Promise<NoteLike | null>;
    updateNote(id: string, updates: {
      content?: string;
      path?: string;
      metadata?: Record<string, unknown>;
    }): Promise<NoteLike>;
    deleteNote(id: string): Promise<void>;
    queryNotes(opts: QueryOptsLike): Promise<NoteLike[]>;
    searchNotes(query: string, opts?: { tags?: string[]; limit?: number }): Promise<NoteLike[]>;

    listTags(): Promise<{ name: string; count: number }[]>;
    tagNote(noteId: string, tags: string[]): Promise<void>;
    untagNote(noteId: string, tags: string[]): Promise<void>;
    deleteTag(name: string): Promise<{ deleted: boolean; notes_untagged: number }>;

    getVaultStats(opts?: { topTagsLimit?: number }): Promise<VaultStatsSummary>;
  }
}
