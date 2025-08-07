import { embeddings } from "../../config/vectorStore";
import { FaissStore } from "@langchain/community/vectorstores/faiss";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";
import fs from "fs";
import path from "path";

const govDocsPath = "./data/source_docs/gov"; 
const outputPath = "./data/embeddings/gov-data";

export async function buildGovVectorStore(): Promise<FaissStore> {
  if (!fs.existsSync(govDocsPath)) {
    fs.mkdirSync(govDocsPath, { recursive: true });
    throw new Error(`Missing source folder: ${govDocsPath}. Created it for you. Please add PDFs and re-run.`);
  }

  const pdfFiles = fs.readdirSync(govDocsPath).filter(file => file.endsWith(".pdf"));
  if (pdfFiles.length === 0) {
    throw new Error("No PDF files found for indexing.");  
  }

  const allDocs = [];

  for (const file of pdfFiles) {
    const filePath = path.join(govDocsPath, file);
    const loader = new PDFLoader(filePath);
    const docs = await loader.load();
    allDocs.push(...docs);
  }

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 500,
    chunkOverlap: 50,
    separators: ["\n\n", "\n", ". ", "! ", "? ", " ", ""]
  });

  const splitDocs = await splitter.splitDocuments(allDocs);
  const vectorStore = await FaissStore.fromDocuments(splitDocs, embeddings);

  await vectorStore.save(outputPath);
  console.log("✅ FAISS vector store created at:", outputPath);

  return vectorStore;
}

export async function loadGovVectorStore(): Promise<FaissStore> {

  const basePath = path.resolve("data/embeddings/gov-data");
  if (!fs.existsSync(path.join(basePath, "faiss.index"))) {
    throw new Error(`Missing FAISS index at ${basePath}`);
  }
  return await FaissStore.load("./data/embeddings/gov-data", embeddings);
}


