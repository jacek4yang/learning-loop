export interface CiphertextCache {
  get(hash: string): Promise<Uint8Array | undefined>;
  put(hash: string, ciphertext: Uint8Array): Promise<void>;
  remove(hash: string): Promise<void>;
}

export class MemoryCiphertextCache implements CiphertextCache {
  private readonly values = new Map<string, Uint8Array>();

  get(hash: string): Promise<Uint8Array | undefined> {
    return Promise.resolve(this.values.get(hash)?.slice());
  }

  put(hash: string, ciphertext: Uint8Array): Promise<void> {
    this.values.set(hash, ciphertext.slice());
    return Promise.resolve();
  }

  remove(hash: string): Promise<void> {
    this.values.delete(hash);
    return Promise.resolve();
  }
}

export class IndexedDbCiphertextCache implements CiphertextCache {
  constructor(
    private readonly databaseName: string,
    private readonly indexedDb: IDBFactory = indexedDB,
  ) {}

  async get(hash: string): Promise<Uint8Array | undefined> {
    return this.withStore("readonly", async (store) => {
      const result = await requestResult<ArrayBuffer | undefined>(
        store.get(hash) as IDBRequest<ArrayBuffer | undefined>,
      );
      return result === undefined ? undefined : new Uint8Array(result);
    });
  }

  async put(hash: string, ciphertext: Uint8Array): Promise<void> {
    await this.withStore("readwrite", async (store) => {
      store.put(
        ciphertext.buffer.slice(
          ciphertext.byteOffset,
          ciphertext.byteOffset + ciphertext.byteLength,
        ),
        hash,
      );
      return transactionRequestQueued();
    });
  }

  async remove(hash: string): Promise<void> {
    await this.withStore("readwrite", async (store) => {
      store.delete(hash);
      return transactionRequestQueued();
    });
  }

  private async withStore<T>(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => Promise<T>,
  ): Promise<T> {
    const database = await this.open();
    try {
      const transaction = database.transaction("ciphertexts", mode);
      const result = await operation(transaction.objectStore("ciphertexts"));
      await transactionDone(transaction);
      return result;
    } finally {
      database.close();
    }
  }

  private async open(): Promise<IDBDatabase> {
    const request = this.indexedDb.open(this.databaseName, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("ciphertexts")) {
        request.result.createObjectStore("ciphertexts");
      }
    };
    return requestResult(request);
  }
}

function transactionRequestQueued(): Promise<void> {
  return Promise.resolve();
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
