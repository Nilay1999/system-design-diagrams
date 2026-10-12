import { createContext, useContext } from "react";

import { createLocalTopicRepository, type LocalTopicRepository } from "./repository";

/** Defaults to IndexedDB; tests (or a future sync layer) provide another implementation. */
export const RepositoryContext = createContext<LocalTopicRepository>(createLocalTopicRepository());

export const useRepository = () => useContext(RepositoryContext);
