import { HuggingFaceTransformersEmbeddings } from "@langchain/community/embeddings/huggingface_transformers";

export const embeddings = new HuggingFaceTransformersEmbeddings({
  model: "sentence-transformers/all-MiniLM-L6-v2"
});
