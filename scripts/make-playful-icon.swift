import AppKit

// Playful Agent Remote concept: a friendly hub and three connected agents.
let destination = URL(fileURLWithPath: CommandLine.arguments[1])
try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
let ios = CommandLine.arguments.contains("--ios")
let brand = CommandLine.arguments.contains("--brand")
let charcoal = NSColor(srgbRed: 20/255, green: 42/255, blue: 40/255, alpha: 1)
let mint = NSColor(srgbRed: 113/255, green: 228/255, blue: 187/255, alpha: 1)

func mark(_ dimension: CGFloat, color: NSColor) {
    func point(_ x: CGFloat, _ y: CGFloat) -> NSPoint { NSPoint(x: x * dimension / 100, y: (100-y) * dimension / 100) }
    color.setStroke(); color.setFill()
    let links = NSBezierPath()
    for (x, y): (CGFloat, CGFloat) in [(54,22), (24,70), (77,65)] {
        links.move(to: point(50, 52)); links.line(to: point(x,y))
    }
    links.lineWidth = dimension * 0.055; links.lineCapStyle = .round; links.stroke()
    for (x, y): (CGFloat, CGFloat) in [(54,22), (24,70), (77,65)] {
        let p = point(x,y), r = dimension * 0.075
        NSBezierPath(ovalIn: NSRect(x:p.x-r,y:p.y-r,width:2*r,height:2*r)).fill()
    }
    // Clear the hub interior, leaving a distinct ring at every size.
    let hub = point(50,52), r = dimension * 0.15
    NSGraphicsContext.current!.compositingOperation = .clear
    NSBezierPath(ovalIn: NSRect(x:hub.x-r,y:hub.y-r,width:2*r,height:2*r)).fill()
    NSGraphicsContext.current!.compositingOperation = .sourceOver
    let ring = NSBezierPath(ovalIn: NSRect(x:hub.x-r,y:hub.y-r,width:2*r,height:2*r))
    ring.lineWidth = dimension * 0.045; ring.stroke()
    // Two bright eyes and a small, off-center smile give the hub some personality.
    for x: CGFloat in [45,55] {
        let eye = point(x,49)
        NSBezierPath(roundedRect:NSRect(x:eye.x-dimension*0.014,y:eye.y-dimension*0.022,width:dimension*0.028,height:dimension*0.044),xRadius:dimension*0.014,yRadius:dimension*0.014).fill()
    }
    if dimension >= 100 {
        let smile = NSBezierPath()
        smile.move(to:point(45.5,56))
        smile.curve(to:point(55.5,54.7),controlPoint1:point(48,59.5),controlPoint2:point(53,59))
        smile.lineWidth = dimension*0.019; smile.lineCapStyle = .round; smile.stroke()
    }
}

func render(_ pixels: Int, background: Bool, rounded: Bool, color: NSColor, file: String, opaque: Bool = false) throws {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes:nil,pixelsWide:pixels,pixelsHigh:pixels,bitsPerSample:8,samplesPerPixel:4,hasAlpha:true,isPlanar:false,colorSpaceName:.deviceRGB,bytesPerRow:0,bitsPerPixel:0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    let d = CGFloat(pixels)
    // Draw the transparent mark separately so the hub reveals the background.
    mark(d, color: color)
    if background {
        NSGraphicsContext.current!.compositingOperation = .destinationOver
        charcoal.setFill()
        let bounds = rounded ? NSRect(x:d*0.07,y:d*0.07,width:d*0.86,height:d*0.86) : NSRect(x:0,y:0,width:d,height:d)
        NSBezierPath(roundedRect:bounds,xRadius:rounded ? d*0.19 : 0,yRadius:rounded ? d*0.19 : 0).fill()
    }
    NSGraphicsContext.restoreGraphicsState()
    var result = bitmap
    if opaque {
        result = NSBitmapImageRep(bitmapDataPlanes:nil,pixelsWide:pixels,pixelsHigh:pixels,bitsPerSample:8,samplesPerPixel:3,hasAlpha:false,isPlanar:false,colorSpaceName:.deviceRGB,bytesPerRow:0,bitsPerPixel:0)!
        for y in 0..<pixels {
            for x in 0..<pixels {
                let source = bitmap.bitmapData! + y * bitmap.bytesPerRow + x * 4
                let target = result.bitmapData! + y * result.bytesPerRow + x * 3
                target[0] = source[0]; target[1] = source[1]; target[2] = source[2]
            }
        }
    }
    try result.representation(using:.png,properties:[:])!.write(to:destination.appendingPathComponent(file))
}
if brand {
    try render(1024,background:true,rounded:false,color:mint,file:"AgentRemote-iOS.png",opaque:true)
    try render(1024,background:true,rounded:true,color:mint,file:"AgentRemote-macOS.png")
    try render(1024,background:false,rounded:false,color:mint,file:"AgentRemote-logo.png")
    // Template alpha lets macOS choose the right color for either menu bar appearance.
    for scale in [1,2,3] {
        try render(22*scale,background:false,rounded:false,color:.black,file:scale == 1 ? "MenuBarTemplate.png" : "MenuBarTemplate@\(scale)x.png")
    }
} else {
    for size in (ios ? [1024] : [16,32,128,256,512]) {
        for scale in (ios ? [1] : [1,2]) {
            let suffix = scale == 1 ? "" : "@2x"
            try render(size*scale,background:true,rounded: !ios,color:mint,file:ios ? "AppIcon.png" : "icon_\(size)x\(size)\(suffix).png",opaque:ios)
        }
    }
}
