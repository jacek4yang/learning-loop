import {
  EMPTY_SYNC_STATE,
  type SyncState,
} from "./types";

export interface StateRepository {
  read(): Promise<SyncState>;
  update(transform: (state: SyncState) => SyncState): Promise<SyncState>;
  replace(state: SyncState): Promise<void>;
}

export class MemoryStateRepository implements StateRepository {
  private state: SyncState;
  private tail: Promise<void> = Promise.resolve();

  constructor(initial: SyncState = EMPTY_SYNC_STATE) {
    this.state = cloneState(initial);
  }

  async read(): Promise<SyncState> {
    await this.tail;
    return cloneState(this.state);
  }

  async update(transform: (state: SyncState) => SyncState): Promise<SyncState> {
    let result = this.state;
    const operation = this.tail.then(() => {
      result = validateState(transform(cloneState(this.state)));
      this.state = cloneState(result);
    });
    this.tail = operation.catch(() => undefined);
    await operation;
    return cloneState(result);
  }

  async replace(state: SyncState): Promise<void> {
    await this.update(() => state);
  }
}

export class IndexedDbStateRepository implements StateRepository {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly databaseName: string,
    private readonly indexedDb: IDBFactory = indexedDB,
  ) {}

  async read(): Promise<SyncState> {
    await this.tail;
    const database = await this.open();
    try {
      const transaction = database.transaction("state", "readonly");
      const stored = await requestResult<SyncState | undefined>(
        transaction.objectStore("state").get("current") as IDBRequest<
          SyncState | undefined
        >,
      );
      await transactionDone(transaction);
      return stored === undefined
        ? cloneState(EMPTY_SYNC_STATE)
        : validateState(stored);
    } finally {
      database.close();
    }
  }

  async update(transform: (state: SyncState) => SyncState): Promise<SyncState> {
    let result = EMPTY_SYNC_STATE;
    const operation = this.tail.then(async () => {
      const database = await this.open();
      try {
        const transaction = database.transaction("state", "readwrite");
        const store = transaction.objectStore("state");
        const stored = await requestResult<SyncState | undefined>(
          store.get("current") as IDBRequest<SyncState | undefined>,
        );
        result = validateState(
          transform(
            stored === undefined ? cloneState(EMPTY_SYNC_STATE) : validateState(stored),
          ),
        );
        store.put(cloneState(result), "current");
        await transactionDone(transaction);
      } finally {
        database.close();
      }
    });
    this.tail = operation.catch(() => undefined);
    await operation;
    return cloneState(result);
  }

  async replace(state: SyncState): Promise<void> {
    await this.update(() => state);
  }

  private async open(): Promise<IDBDatabase> {
    const request = this.indexedDb.open(this.databaseName, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("state")) {
        request.result.createObjectStore("state");
      }
    };
    return requestResult(request);
  }
}

export function validateState(state: SyncState): SyncState {
  state = {
    ...state,
    commits: state.commits ?? [],
    stagedObjects: state.stagedObjects ?? [],
  };
  if (
    state.schema !== 1
    || !isUnsigned(state.deviceSequence)
    || !isUnsigned(state.lamport)
  ) {
    throw new Error("invalid sync state");
  }
  const objectIds = new Set<string>();
  const activePaths = new Set<string>();
  for (const record of state.records) {
    if (objectIds.has(record.objectId) || !isUnsigned(record.revision)) {
      throw new Error("duplicate or invalid object state");
    }
    objectIds.add(record.objectId);
    if (!record.tombstone) {
      if (activePaths.has(record.path)) {
        throw new Error("duplicate active sync path");
      }
      activePaths.add(record.path);
    }
  }
  const pendingIds = new Set<string>();
  for (const operation of state.pending) {
    if (
      pendingIds.has(operation.operationId)
      || !isUnsigned(operation.baseRevision)
      || !isUnsigned(operation.revision)
    ) {
      throw new Error("duplicate or invalid pending operation");
    }
    pendingIds.add(operation.operationId);
  }
  const commitIds = new Set<string>();
  for (const commit of state.commits) {
    if (
      commitIds.has(commit.commitId)
      || !isUnsigned(commit.logicalTimestamp)
      || !isUnsigned(commit.deviceSequence)
    ) {
      throw new Error("duplicate or invalid commit summary");
    }
    commitIds.add(commit.commitId);
  }
  return cloneState(state);
}

function isUnsigned(value: string): boolean {
  return /^(0|[1-9]\d*)$/u.test(value);
}

function cloneState(state: SyncState): SyncState {
  return structuredClone(state);
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error("IndexedDB request failed"));
    };
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => {
      resolve();
    };
    transaction.onabort = () => {
      reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    };
    transaction.onerror = () => {
      reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    };
  });
}
