// Port: ImagingGateway.imageUrl(serviceCode) -> string | null
// Mock: link ảnh mẫu. HIS thật nối PACS qua DICOM.
export const imagingGateway = {
  async imageUrl(code) { return code.startsWith('CDHA') ? `https://pacs.example/sample/${code}` : null; },
};
