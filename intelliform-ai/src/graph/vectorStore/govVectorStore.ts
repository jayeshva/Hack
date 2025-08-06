import { embeddings } from "../../config/vectorStore";
import { FaissStore } from "@langchain/community/vectorstores/faiss";
import { TextLoader } from "langchain/document_loaders/fs/text";
import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";
import fs from "fs";

const govDocsPath = "./data";

export async function buildGovVectorStore(): Promise<FaissStore> {
  const path = "data/embeddings/gov-data/faiss.index";
  if (!fs.existsSync(path)) {
    throw new Error("Gov vector store not initialized. Please run indexing script.");
  }
  const loader = new TextLoader(govDocsPath);
  const docs = await loader.load();
  const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 500, chunkOverlap: 50, separators: ["\n\n", "\n", ". ", "! ", "? ", " ", ""] });
  const splitDocs = await splitter.splitDocuments(docs);
  const vectorStore = await FaissStore.fromDocuments(splitDocs, embeddings);
  await vectorStore.save("./data/embeddings/gov-data");
  return vectorStore;
}

export async function loadGovVectorStore(): Promise<FaissStore> {
  return await FaissStore.load("./data/embeddings/gov-data", embeddings);
}