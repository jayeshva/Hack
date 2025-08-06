import { loadGovVectorStore } from "../graph/vectorStore/govVectorStore";

export const govDataReadTool = async (query: string) => {
  const store = await loadGovVectorStore();
  const retriever = store.asRetriever();
  return await retriever.invoke(query);
};