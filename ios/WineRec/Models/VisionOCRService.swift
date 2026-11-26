import UIKit
@preconcurrency import Vision

struct VisionOCRResult {
    let recognizedText: String
    let lineCount: Int
    let layout: ClientOCRLayout
}

enum VisionOCRError: LocalizedError {
    case missingCGImage
    case noTextRecognized

    var errorDescription: String? {
        switch self {
        case .missingCGImage:
            return "The selected image could not be read."
        case .noTextRecognized:
            return "Apple Vision could not find readable wine-list text in this image."
        }
    }
}

struct VisionOCRService {
    func recognizeText(in image: UIImage) async throws -> VisionOCRResult {
        guard let cgImage = image.cgImage else {
            throw VisionOCRError.missingCGImage
        }
        let orientation = CGImagePropertyOrientation(image.imageOrientation)

        return try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                do {
                    let output = try VisionOCRCore.recognize(cgImage: cgImage, orientation: orientation)
                    guard !output.recognizedText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                        continuation.resume(throwing: VisionOCRError.noTextRecognized)
                        return
                    }
                    continuation.resume(returning: VisionOCRResult(
                        recognizedText: output.recognizedText,
                        lineCount: output.lineCount,
                        layout: output.layout
                    ))
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }
}

private extension CGImagePropertyOrientation {
    init(_ orientation: UIImage.Orientation) {
        switch orientation {
        case .up:
            self = .up
        case .upMirrored:
            self = .upMirrored
        case .down:
            self = .down
        case .downMirrored:
            self = .downMirrored
        case .left:
            self = .left
        case .leftMirrored:
            self = .leftMirrored
        case .right:
            self = .right
        case .rightMirrored:
            self = .rightMirrored
        @unknown default:
            self = .up
        }
    }
}
