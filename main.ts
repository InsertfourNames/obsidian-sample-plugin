import { App, Plugin, ItemView, WorkspaceLeaf } from 'obsidian';

type GalleryMode = "explicit" | "virtual";
type LogicMode = "disable" | "or" | "and" | "not";
type RawGalleryData = { content: string[]; galleryName: string };

type VirtualGalleryEntry = {
  properties: string[];
  galleries: string[];
};

interface MarkdownGallerySource {
  getGalleryContent(app: App): Promise<string[]>;
}

interface SearchFieldController {
  wrapper: HTMLElement;
  getMode: () => LogicMode;
  getSelected: () => string[];
}

interface oneGalleryEntry {
  filename: string;
  gallery: string;
  properties: string[];
}

interface GalleryEntry {
  filename: string;
  galleries: string[];
  properties: string[];
}

class ExplicitNameGallerySource implements MarkdownGallerySource {
  constructor(private galleryNames: string[]) { }

  async getGalleryContent(app: App): Promise<string[]> {
    const mdFiles = app.vault.getMarkdownFiles();
    const contents = [];

    for (const name of this.galleryNames) {
      const file = mdFiles.find(f => f.basename === name);
      if (!file) continue;
      const content = await app.vault.cachedRead(file);
      contents.push(content);
    }

    return contents;
  }
}

class ExtractGalleryData {
  constructor(
    private app: App,
    private mode: GalleryMode,
    private sourceData: string[]
  ) {}

  async extract(): Promise<Map<string, GalleryEntry>> {
    const rawData = await this.getGalleryContent();
    const parsedEntries: oneGalleryEntry[] = [];

    for (const { content, galleryName } of rawData) {
      for (const line of content) {
        const parsed = parseGalleryLine(line, galleryName);
        if (parsed) parsedEntries.push(parsed);
      }
    }

    const imageMap = new Map<string, GalleryEntry>();

    for (const entry of parsedEntries) {
      const existing = imageMap.get(entry.filename) ?? {
        filename: entry.filename,
        galleries: [],
        properties: [],
      };

      if (!existing.galleries.includes(entry.gallery)) {
        existing.galleries.push(entry.gallery);
      }

      entry.properties.forEach(prop => {
        if (!existing.properties.includes(prop)) {
          existing.properties.push(prop);
        }
      });

      imageMap.set(entry.filename, existing);
    }

    return imageMap;
  }

  private async getGalleryContent(): Promise<RawGalleryData[]> {
    const mdFiles = this.app.vault.getMarkdownFiles();
    const results: RawGalleryData[] = [];

    if (this.mode === "explicit") {
      for (const name of this.sourceData) {
        const file = mdFiles.find(f => f.basename === name);
        if (!file) continue;
        const content = await this.app.vault.cachedRead(file);
        results.push({ content: content.split("\n"), galleryName: file.basename });
      }
    } else if (this.mode === "virtual") {
      for (const file of mdFiles) {
        const content = await this.app.vault.cachedRead(file);
        if (this.sourceData.some(tag => content.includes(tag))) {
          results.push({ content: content.split("\n"), galleryName: file.basename });
        }
      }
    }

    return results;
  }
}

function evaluateField(value: string | string[], terms: string[], mode: LogicMode): boolean {
  if (mode === "disable") return true;

  const values = Array.isArray(value)
    ? value.map(v => v.toLowerCase())
    : [value.toLowerCase()];

  const termsLower = terms.map(t => t.toLowerCase());

  if (terms.length === 0) {
    return mode === "not";
  }

  switch (mode) {
    case "or":
      return termsLower.some(term =>
        values.some(v => v.includes(term))
      );
    case "and":
      return termsLower.every(term =>
        values.some(v => v.includes(term))
      );
    case "not":
      return termsLower.every(term =>
        values.every(v => !v.includes(term))
      );
  }
}

class TagBasedGallerySource implements MarkdownGallerySource {
  constructor(private tag: string = "#mdGallery") { }

  async getGalleryContent(app: App): Promise<string[]> {
    const mdFiles = app.vault.getMarkdownFiles();
    const result = [];

    for (const file of mdFiles) {
      const content = await app.vault.cachedRead(file);
      if (content.includes(this.tag)) result.push(content);
    }

    return result;
  }
}

function createSearchBlock(label: string, suggestions: string[]): SearchFieldController {
  const wrapper = document.createElement("div");
  wrapper.className = "search-block";

  const title = wrapper.createEl("label", { text: label });

  const selectEl = document.createElement("select");
  [ "disable", "or", "and", "not" ].forEach((mode) => {
    const opt = document.createElement("option");
    opt.value = opt.text = mode;
    selectEl.appendChild(opt);
  });

  const input = document.createElement("input");
  input.placeholder = "Type to search...";

  const selectedList: string[] = [];
  const suggestionList = document.createElement("ul");
  const chipList = document.createElement("div");

  function updateChips() {
    chipList.innerHTML = "";
    selectedList.forEach(tag => {
      const chip = document.createElement("span");
      chip.textContent = tag;
      chip.className = "search-chip";
      chip.onclick = () => {
        selectedList.splice(selectedList.indexOf(tag), 1);
        updateChips();
      };
      chipList.appendChild(chip);
    });
  }

  input.addEventListener("input", () => {
    suggestionList.innerHTML = "";
    const val = input.value.toLowerCase();
    suggestions
      .filter(tag => tag.toLowerCase().includes(val) && !selectedList.includes(tag))
      .forEach(match => {
        const item = document.createElement("li");
        item.textContent = match;
        item.onclick = () => {
          selectedList.push(match);
          input.value = "";
          suggestionList.innerHTML = "";
          updateChips();
        };
        suggestionList.appendChild(item);
      });
  });

  wrapper.append(title, selectEl, input, suggestionList, chipList);

  return {
    wrapper,
    getMode: () => selectEl.value as LogicMode,
    getSelected: () => [...selectedList],
  };
}

function parseGalleryLine(line: string, gallery: string): oneGalleryEntry | null {
  const match = line.match(/<!\[\[(.*?)\]\]<(.*?)>>/) || line.match(/!\[\[(.*?)\]\]/);
  if (!match) return null;

  const filename = match[1];
  const props = match[2]?.split(",").map(p => p.trim()) ?? [];

  return {
    filename,
    gallery,
    properties: props,
  };
}

async function extractAutocompleteOptions(app: App): Promise<{
  filenames: Set<string>;
  galleries: Set<string>;
  properties: Set<string>;
}> {
  const files = app.vault.getMarkdownFiles();
  const filenames = new Set<string>();
  const galleries = new Set<string>();
  const properties = new Set<string>();

  for (const file of files) {
    const content = await app.vault.cachedRead(file);
    if (!content.includes("#mdGallery")) continue;

    galleries.add(file.basename);

    content.split("\n").forEach(line => {
      const parsed = parseGalleryLine(line, file.basename);
      if (!parsed) return;
      filenames.add(parsed.filename);
      parsed.properties.forEach(p => properties.add(p));
    });
  }

  return { filenames, galleries, properties };
}

interface MultiSearchFilter {
  filenameMode: LogicMode;
  galleryMode: LogicMode;
  propertyMode: LogicMode;
  filenameTerms: string[];
  galleryTerms: string[];
  propertyTerms: string[];
}

class GalleryDisplay {
  constructor(
    private app: App,
  ) { }

  createThumbnailGallery() {
    const div = document.createElement("div");
    div.className = "thumbnail-gallery";
    return div;
  }

  createLabelSet(labels: string[]): HTMLDivElement {
    const container = document.createElement("div");
    container.className = "thumbnail-labels";

    labels.forEach(label => {
      const el = document.createElement("label");
      el.className = "thumbnail-label";
      el.innerText = label;
      container.appendChild(el);
    });

    return container;
  }

  createButton(filePath: string, fileName: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.className = "thumbnail-button";
    Object.assign(button.style, {
      backgroundImage: `url(${filePath})`,
      backgroundSize: "cover",
      backgroundPosition: "center",
      border: "none",
      cursor: "pointer",
    });

    button.addEventListener("click", () => {
      this.app.workspace.openLinkText(fileName, "", true);
    });

    return button;
  }

  processThumbnail(fileName: string, data: { properties: string[]; galleries: string[] }, parent: HTMLElement) {
    const ogFile = this.app.vault.getFiles().find(f => f.name === fileName);
    if (!ogFile) return;

    const filePath = this.app.vault.getResourcePath(ogFile);
    const thumbGroup = document.createElement("div");
    thumbGroup.className = "thumbnail-entry";

    const button = this.createButton(filePath, fileName);
    const labels = this.createLabelSet([...data.galleries, ...data.properties]);

    thumbGroup.appendChild(button);
    thumbGroup.appendChild(labels);
    parent.appendChild(thumbGroup);
  }
}

export class GallerySearchView extends ItemView {
  app: App;
  contentSource: MarkdownGallerySource;
  galleryMode: GalleryMode;
  sourceData: string[];
  constructor(
    leaf: WorkspaceLeaf,
    app: App,
    contentSource: MarkdownGallerySource,
    galleryMode: GalleryMode,
    sourceData: string[]
  ) {
    super(leaf);
    this.app = app;
    this.contentSource = contentSource;
    this.galleryMode = galleryMode;
    this.sourceData = sourceData;
  }

  getViewType() {
    return "gallery-search-view";
  }

  getDisplayText() {
    return "Gallery Search";
  }

  async onOpen() {
    const container = this.containerEl.children[1];
    container.empty();

    const suggestions = await extractAutocompleteOptions(this.app);
    const filtersDiv = container.createDiv({ cls: "gallery-filters" });

    const fileBlock = createSearchBlock("Filename", [...suggestions.filenames]);
    const galleryBlock = createSearchBlock("Gallery", [...suggestions.galleries]);
    const propBlock = createSearchBlock("Properties", [...suggestions.properties]);
    const confirmButton = filtersDiv.createEl("button", { text: "Search" });

    filtersDiv.append(fileBlock.wrapper, galleryBlock.wrapper, propBlock.wrapper, confirmButton);

    const extractor = new ExtractGalleryData(this.app, "virtual", ["#mdGallery"]);
    const fullImageMap = await extractor.extract();

    const resultsDiv = container.createDiv({ cls: "search-gallery-container" });

    confirmButton.onclick = async () => {
      resultsDiv.empty();

      const filters: MultiSearchFilter = {
        filenameTerms: fileBlock.getSelected(),
        galleryTerms: galleryBlock.getSelected(),
        propertyTerms: propBlock.getSelected(),
        filenameMode: fileBlock.getMode(),
        galleryMode: galleryBlock.getMode(),
        propertyMode: propBlock.getMode(),
      };

      const virtualMap = new Map<string, VirtualGalleryEntry>();

      for (const [filename, entry] of fullImageMap.entries()) {
        const fileMatch = evaluateField(filename, filters.filenameTerms, filters.filenameMode);
        const galleryMatch = evaluateField(entry.galleries, filters.galleryTerms, filters.galleryMode);
        const propMatch = evaluateField(entry.properties, filters.propertyTerms, filters.propertyMode);

        const shouldInclude = [
          filters.filenameMode === "disable" || fileMatch,
          filters.galleryMode === "disable" || galleryMatch,
          filters.propertyMode === "disable" || propMatch,
        ].every(Boolean);

        if (shouldInclude) {
          virtualMap.set(filename, {
            properties: entry.properties,
            galleries: entry.galleries,
          });
        }
      }
      const galleryGrid = document.createElement("div");
      galleryGrid.className = "thumbnail-grid";
      resultsDiv.appendChild(galleryGrid);

      for (const [filename, data] of virtualMap.entries()) {
        const file = this.app.vault.getFiles().find(f => f.name === filename);
        if (!file) continue;

        const gallery = new GalleryDisplay(
          this.app
        );
        gallery.processThumbnail(filename, { properties: data.properties, galleries: data.galleries }, galleryGrid);
      }
    }
  }
}

class GalleryInCodeBlock {
  app: App;
  parentElement: HTMLElement;
  contentSource: MarkdownGallerySource;
  galleryMode: GalleryMode;
  sourceData: string[];

  constructor(
    app: App,
    parentElement: HTMLElement,
    contentSource: MarkdownGallerySource,
    galleryMode: GalleryMode,
    sourceData: string[]
  ) {
    this.app = app;
    this.parentElement = parentElement;
    this.contentSource = contentSource;
    this.galleryMode = galleryMode;
    this.sourceData = sourceData;
    this.onload();
  }

  async onload() {
    const extractor = new ExtractGalleryData(this.app, this.galleryMode, this.sourceData);
    const fullMap = await extractor.extract();

    const container = this.parentElement.createDiv({ cls: "codeblock-gallery-container" });
    const galleryGrid = document.createElement("div");
    galleryGrid.className = "thumbnail-grid";
    container.appendChild(galleryGrid);

    for (const [filename, entry] of fullMap.entries()) {
      const file = this.app.vault.getFiles().find(f => f.name === filename);
      if (!file) continue;

      const gallery = new GalleryDisplay(
        this.app
      );

      gallery.processThumbnail(filename, { properties: entry.properties, galleries: entry.galleries }, galleryGrid);

    }
  }
}

export default class GalleryPlugin extends Plugin {
  onload() {
    this.registerMarkdownCodeBlockProcessor("thumbGallery", async (source, el, ctx) => {
      el.innerHTML = "";

      const galleryNames = [...source.matchAll(/\[\[(.*?)\]\]/g)].map((m) => m[1]);
      const contentSource = new ExplicitNameGallerySource(galleryNames);

      new GalleryInCodeBlock(this.app, el, contentSource, "explicit", galleryNames);
    });

    this.addRibbonIcon("search", "Open Gallery Search", () => {
      this.activateView();
    });

    this.setupGalleryView();
  }

  async setupGalleryView() {
    const tag = "#mdGallery";
    const tagGallerySource = new TagBasedGallerySource(tag);
    const sourceData = [tag];

    this.registerView(
      "gallery-search-view",
      (leaf) =>
        new GallerySearchView(leaf, this.app, tagGallerySource, "virtual", sourceData)
    );
  }

  async activateView() {
    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({
        type: "gallery-search-view",
        active: true,
      });
      this.app.workspace.revealLeaf(leaf);
    }
  }
}