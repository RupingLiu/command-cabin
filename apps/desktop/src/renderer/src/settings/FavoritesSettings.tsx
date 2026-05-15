import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  FavoriteCreateRequest,
  FavoriteListRecord,
  FavoriteUpdateRequest,
} from '../../../shared/favoritesApi.js';

type FavoriteKind = FavoriteListRecord['kind'];

export interface FavoritesSettingsApi {
  addFavorite: (input: FavoriteCreateRequest) => Promise<FavoriteListRecord>;
  listFavorites: () => Promise<FavoriteListRecord[]>;
  removeFavorite: (id: string) => Promise<boolean>;
  updateFavorite: (
    id: string,
    input: FavoriteUpdateRequest,
  ) => Promise<FavoriteListRecord | undefined>;
}

export interface FavoritesSettingsProps {
  api?: FavoritesSettingsApi;
}

export interface FavoriteDraft {
  kind: FavoriteKind;
  keywordsText: string;
  target: string;
  title: string;
}

type FavoritesOperationKind = 'saving' | 'deleting';

export interface FavoritesOperationGate {
  finish: (operation: FavoritesOperationKind) => void;
  isBusy: () => boolean;
  tryStart: (operation: FavoritesOperationKind) => boolean;
}

export interface FavoritesLoadGate {
  finish: (token: number) => void;
  isCurrent: (token: number) => boolean;
  start: () => number;
}

const EMPTY_FAVORITE_DRAFT: FavoriteDraft = {
  kind: 'file',
  keywordsText: '',
  target: '',
  title: '',
};

export function createFavoritesOperationGate(): FavoritesOperationGate {
  let currentOperation: FavoritesOperationKind | undefined;

  return {
    finish: (operation) => {
      if (currentOperation === operation) {
        currentOperation = undefined;
      }
    },
    isBusy: () => currentOperation !== undefined,
    tryStart: (operation) => {
      if (currentOperation !== undefined) {
        return false;
      }

      currentOperation = operation;
      return true;
    },
  };
}

export function createFavoritesLoadGate(): FavoritesLoadGate {
  let currentToken = 0;

  return {
    finish: (token) => {
      if (currentToken === token) {
        currentToken = 0;
      }
    },
    isCurrent: (token) => currentToken === token,
    start: () => {
      currentToken += 1;
      return currentToken;
    },
  };
}

function getDefaultFavoritesApi(): FavoritesSettingsApi | undefined {
  if (typeof window === 'undefined' || !('desktopApi' in window)) {
    return undefined;
  }

  return window.desktopApi;
}

function getFavoriteTarget(favorite: FavoriteListRecord): string {
  return favorite.kind === 'url' ? favorite.url : favorite.path;
}

function getTargetLabel(kind: FavoriteKind): string {
  return kind === 'url' ? 'URL' : 'Path';
}

export function parseFavoriteKeywordsInput(input: string): string[] {
  const keywords: string[] = [];
  const seenKeywords = new Set<string>();

  for (const rawKeyword of input.split(/[,\n]/)) {
    const keyword = rawKeyword.trim();

    if (keyword.length === 0 || seenKeywords.has(keyword)) {
      continue;
    }

    keywords.push(keyword);
    seenKeywords.add(keyword);
  }

  return keywords;
}

export function createFavoriteDraftFromRecord(favorite: FavoriteListRecord): FavoriteDraft {
  return {
    kind: favorite.kind,
    keywordsText: favorite.keywords.join(', '),
    target: getFavoriteTarget(favorite),
    title: favorite.title,
  };
}

export function favoriteDraftToCreateRequest(draft: FavoriteDraft): FavoriteCreateRequest {
  const request = {
    kind: draft.kind,
    title: draft.title.trim(),
    keywords: parseFavoriteKeywordsInput(draft.keywordsText),
    metadata: {},
  };

  if (draft.kind === 'url') {
    return {
      ...request,
      kind: draft.kind,
      url: draft.target.trim(),
    };
  }

  return {
    ...request,
    kind: draft.kind,
    path: draft.target.trim(),
  };
}

export function favoriteDraftToUpdateRequest(draft: FavoriteDraft): FavoriteUpdateRequest {
  return {
    title: draft.title.trim(),
    keywords: parseFavoriteKeywordsInput(draft.keywordsText),
  };
}

export function FavoritesSettings({ api }: FavoritesSettingsProps) {
  const favoritesApi = useMemo(() => api ?? getDefaultFavoritesApi(), [api]);
  const loadGateRef = useRef(createFavoritesLoadGate());
  const operationGateRef = useRef(createFavoritesOperationGate());
  const [draft, setDraft] = useState<FavoriteDraft>(EMPTY_FAVORITE_DRAFT);
  const [editingFavoriteId, setEditingFavoriteId] = useState<string | undefined>();
  const [errorMessage, setErrorMessage] = useState<string | undefined>();
  const [favorites, setFavorites] = useState<FavoriteListRecord[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [operation, setOperation] = useState<'idle' | FavoritesOperationKind>('idle');
  const isEditing = editingFavoriteId !== undefined;
  const isMutating = operation !== 'idle';

  const loadFavorites = useCallback(async () => {
    if (!favoritesApi) {
      setErrorMessage('Favorites API unavailable.');
      setFavorites([]);
      return;
    }

    const loadToken = loadGateRef.current.start();

    setIsLoading(true);
    setErrorMessage(undefined);

    try {
      const nextFavorites = await favoritesApi.listFavorites();

      if (loadGateRef.current.isCurrent(loadToken)) {
        setFavorites(nextFavorites);
      }
    } catch (error) {
      if (loadGateRef.current.isCurrent(loadToken)) {
        setErrorMessage(error instanceof Error ? error.message : 'Favorites could not be loaded.');
      }
    } finally {
      if (loadGateRef.current.isCurrent(loadToken)) {
        setIsLoading(false);
        loadGateRef.current.finish(loadToken);
      }
    }
  }, [favoritesApi]);

  useEffect(() => {
    void loadFavorites();
  }, [loadFavorites]);

  const resetDraft = useCallback(() => {
    setDraft(EMPTY_FAVORITE_DRAFT);
    setEditingFavoriteId(undefined);
  }, []);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!favoritesApi) {
      setErrorMessage('Favorites API unavailable.');
      return;
    }

    if (!operationGateRef.current.tryStart('saving')) {
      return;
    }

    setOperation('saving');
    setErrorMessage(undefined);

    try {
      if (editingFavoriteId) {
        await favoritesApi.updateFavorite(editingFavoriteId, favoriteDraftToUpdateRequest(draft));
      } else {
        await favoritesApi.addFavorite(favoriteDraftToCreateRequest(draft));
      }

      resetDraft();
      await loadFavorites();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Favorite could not be saved.');
    } finally {
      operationGateRef.current.finish('saving');
      setOperation('idle');
    }
  };

  const handleDeleteFavorite = async (favoriteId: string) => {
    if (!favoritesApi) {
      setErrorMessage('Favorites API unavailable.');
      return;
    }

    if (!operationGateRef.current.tryStart('deleting')) {
      return;
    }

    setOperation('deleting');
    setErrorMessage(undefined);

    try {
      await favoritesApi.removeFavorite(favoriteId);
      if (editingFavoriteId === favoriteId) {
        resetDraft();
      }
      await loadFavorites();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Favorite could not be deleted.');
    } finally {
      operationGateRef.current.finish('deleting');
      setOperation('idle');
    }
  };

  return (
    <section className="favorites-settings" aria-label="Favorites settings">
      <header className="favorites-settings__header">
        <h2>Favorites</h2>
        <button type="button" onClick={resetDraft} disabled={isMutating}>
          Add
        </button>
      </header>

      {errorMessage ? (
        <p className="favorites-settings__error" role="alert">
          {errorMessage}
        </p>
      ) : null}

      <form className="favorites-settings__form" onSubmit={handleSubmit}>
        <fieldset className="favorites-settings__row favorites-settings__row--kind">
          <legend>Kind</legend>
          {(['file', 'folder', 'url'] as const).map((kind) => (
            <label key={kind} data-selected={draft.kind === kind}>
              <input
                type="radio"
                name="favorite-kind"
                value={kind}
                checked={draft.kind === kind}
                disabled={isEditing || isMutating}
                onChange={() => setDraft((currentDraft) => ({ ...currentDraft, kind }))}
              />
              <span>{kind}</span>
            </label>
          ))}
        </fieldset>

        <label>
          <span>Title</span>
          <input
            value={draft.title}
            onChange={(event) =>
              setDraft((currentDraft) => ({ ...currentDraft, title: event.target.value }))
            }
            disabled={isMutating}
          />
        </label>

        <label>
          <span>{getTargetLabel(draft.kind)}</span>
          <input
            value={draft.target}
            onChange={(event) =>
              setDraft((currentDraft) => ({ ...currentDraft, target: event.target.value }))
            }
            disabled={isEditing || isMutating}
          />
        </label>

        <label>
          <span>Keywords</span>
          <input
            value={draft.keywordsText}
            onChange={(event) =>
              setDraft((currentDraft) => ({ ...currentDraft, keywordsText: event.target.value }))
            }
            disabled={isMutating}
          />
        </label>

        <div className="favorites-settings__actions">
          <button type="submit" disabled={isMutating}>
            {isEditing ? 'Save' : 'Create'}
          </button>
          {isEditing ? (
            <button type="button" onClick={resetDraft} disabled={isMutating}>
              Cancel
            </button>
          ) : null}
        </div>
      </form>

      <div className="favorites-settings__list" aria-busy={isLoading}>
        {favorites.length === 0 ? (
          <p className="favorites-settings__empty">No favorites</p>
        ) : (
          favorites.map((favorite) => (
            <article key={favorite.id} className="favorites-settings__item">
              <div>
                <strong>{favorite.title}</strong>
                <span>{getFavoriteTarget(favorite)}</span>
              </div>
              <small>{favorite.kind}</small>
              <button
                type="button"
                onClick={() => {
                  setEditingFavoriteId(favorite.id);
                  setDraft(createFavoriteDraftFromRecord(favorite));
                }}
                disabled={isMutating}
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() => void handleDeleteFavorite(favorite.id)}
                disabled={isMutating}
              >
                Delete
              </button>
            </article>
          ))
        )}
      </div>
    </section>
  );
}
