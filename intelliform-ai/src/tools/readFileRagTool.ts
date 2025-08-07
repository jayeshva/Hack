import { logger } from "../common/logger";
import { loadGovVectorStore } from "../graph/vectorStore/govVectorStore";

export const govDataReadTool = async (query: string) => {
  logger.info(`govDataReadTool input: ${query}`);
  const store = await loadGovVectorStore();
  const retriever = store.asRetriever();
  return await retriever.invoke(query);
};

