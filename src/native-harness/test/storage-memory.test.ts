import { createMemoryStorageAdapter } from "../src/state/storage/memory.ts";
import { storageConformance } from "./conformance/storage.ts";

storageConformance("memory", createMemoryStorageAdapter);
