
import type { ProjectState, Character, Scene } from '../types';
import { loadProjectPackage } from './zipUtils';

// Helper to detect and remove circular references
const getCircularReplacer = () => {
  const seen = new WeakSet();
  return (key: string, value: any) => {
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) {
        console.warn(`[Save] Circular reference detected at key: ${key}`);
        return "[Circular Reference]";
      }
      seen.add(value);
    }
    return value;
  };
};

export const saveProject = (state: ProjectState, filename: string): void => {
  try {
    // Use replacer to handle circular references
    const dataStr = JSON.stringify(state, getCircularReplacer(), 2);

    // Check if data is too large (warn at 50MB)
    const sizeInMB = new Blob([dataStr]).size / (1024 * 1024);
    if (sizeInMB > 50) {
      console.warn(`[Save] Project file is very large: ${sizeInMB.toFixed(2)} MB. This may cause issues.`);
    }

    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    console.log(`[Save] Project saved successfully: ${filename} (${sizeInMB.toFixed(2)} MB)`);
  } catch (error) {
    console.error("[Save] Failed to save project:", error);
    // More specific error message
    if (error instanceof TypeError && error.message.includes('circular')) {
      alert("Không thể lưu dự án: Dữ liệu bị lỗi tham chiếu vòng (circular reference).");
    } else if (error instanceof RangeError) {
      alert("Không thể lưu dự án: Dữ liệu quá lớn. Vui lòng xóa bớt ảnh.");
    } else {
      alert("Không thể lưu dự án. Vui lòng kiểm tra Console để biết chi tiết lỗi.");
    }
  }
};

const migrateCharacter = (char: any): Character => {
  // Logic chuyển đổi dữ liệu cũ sang mới
  if (Array.isArray(char.images)) {
    // Nếu là file cũ, lấy ảnh đầu tiên làm Face, ảnh thứ 2 làm Body
    const faceImage = char.images[0] || null;
    const bodyImage = char.images[1] || null;
    // Các ảnh còn lại coi như là props nhưng chưa có tên
    const props = char.images.slice(2).map((img: string, idx: number) => ({
      id: `prop_${Date.now()}_${idx}`,
      name: `Prop ${idx + 1}`,
      image: img
    }));

    // Fill cho đủ 3 props rỗng nếu thiếu
    while (props.length < 3) {
      props.push({
        id: `prop_${Date.now()}_${props.length}`,
        name: '',
        image: null
      });
    }

    return {
      ...char,
      masterImage: null, // New field
      characterSheet: null, // Multi-view character sheet
      faceImage,
      bodyImage,
      props: props.slice(0, 3), // Giới hạn 3 props
    };
  }
  // Nếu đã là cấu trúc mới nhưng thiếu masterImage (do update version)
  if (char.masterImage === undefined) {
    return { ...char, masterImage: null, characterSheet: char.characterSheet ?? null };
  }
  // Ensure characterSheet exists
  if (char.characterSheet === undefined) {
    return { ...char, characterSheet: null };
  }
  return char as Character;
};

const migrateScene = (scene: any): Scene => {
  // Auto-fill voiceover from existing text fields if not present
  // Priority: voiceOverText (original VO) → language1 → vietnamese → contextDescription
  let voiceover = scene.voiceover;
  if (!voiceover && (scene.voiceOverText || scene.language1 || scene.vietnamese || scene.contextDescription)) {
    voiceover = scene.voiceOverText || scene.language1 || scene.vietnamese || scene.contextDescription || '';
    console.log(`[Migration] Scene ${scene.sceneNumber || scene.id}: auto-filled voiceover from existing text`);
  }

  return {
    ...scene,
    voiceover,
    veoPrompt: scene.veoPrompt || '' // Default empty string if missing
  };
};

export const openProject = (onLoad: (state: ProjectState) => void): void => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json,.zip,application/zip,application/x-zip-compressed'; // Support ZIP
  input.onchange = async (event: Event) => {
    const target = event.target as HTMLInputElement;
    if (target.files && target.files[0]) {
      const file = target.files[0];

      // Handle ZIP Package
      if (file.name.toLowerCase().endsWith('.zip')) {
        try {
          console.log('[Open] Detected Project Package (ZIP). Unpacking...');
          const loadedState = await loadProjectPackage(file);
          console.log('[Open] ZIP Package loaded successfully.');
          onLoad(loadedState);
        } catch (error) {
          console.error("Failed to load project package:", error);
          alert("Lỗi khi đọc file ZIP dự án. Vui lòng đảm bảo file không bị hỏng.");
        }
        return;
      }

      // Handle Legacy JSON
      const reader = new FileReader();
      reader.onload = (e: ProgressEvent<FileReader>) => {
        try {
          if (e.target && typeof e.target.result === 'string') {
            const rawData = JSON.parse(e.target.result);

            // Migrate characters
            const migratedCharacters = Array.isArray(rawData.characters)
              ? rawData.characters.map(migrateCharacter)
              : [];

            // Migrate scenes
            const migratedScenes = Array.isArray(rawData.scenes)
              ? rawData.scenes.map(migrateScene)
              : [];

            const loadedState: ProjectState = {
              ...rawData,
              stylePrompt: rawData.stylePrompt || 'cinematic-realistic',
              imageModel: rawData.imageModel || 'gemini-2.5-flash-image',
              aspectRatio: rawData.aspectRatio || "16:9",
              scriptLanguage: rawData.scriptLanguage || 'vietnamese',
              characters: migratedCharacters,
              scenes: migratedScenes
            };

            // Basic validation
            if (
              typeof loadedState.projectName !== 'string' ||
              !Array.isArray(loadedState.characters) ||
              !Array.isArray(loadedState.scenes)
            ) {
              throw new Error("Invalid project file format.");
            }
            onLoad(loadedState);
          }
        } catch (error) {
          console.error("Failed to open or parse project file:", error);
          alert("Tệp dự án không hợp lệ hoặc bị hỏng.");
        }
      };
      reader.readAsText(file);
    }
  };
  input.click();
};
