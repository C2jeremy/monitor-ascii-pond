import { createContext, useContext } from "react";
import type { Scene } from "../config/settings";
import { sceneCopy } from "./copy";

export const SceneContext = createContext<Scene>("forest");
export const useScene = () => useContext(SceneContext);
export const useSceneCopy = () => sceneCopy[useContext(SceneContext)];
