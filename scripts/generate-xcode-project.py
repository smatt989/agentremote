#!/usr/bin/env python3
"""Generate the iOS Xcode project. Regeneration resets project signing settings."""
from pathlib import Path
import hashlib

root = Path(__file__).resolve().parents[1] / 'ios'
project = root / 'AgentRemote.xcodeproj'
project.mkdir(exist_ok=True)
def key(value): return hashlib.sha256(value.encode()).hexdigest()[:24].upper()
objects = []
def obj(name, body): objects.append(f'{key(name)} = {{ {body} }};')
files = sorted((root / 'AgentRemote').glob('*.swift'))
for file in files:
    obj(file.name, f'isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = {file.name}; sourceTree = "<group>";')
    obj('build-' + file.name, f'isa = PBXBuildFile; fileRef = {key(file.name)};')
obj('app', 'isa = PBXFileReference; explicitFileType = wrapper.application; path = AgentRemote.app; sourceTree = BUILT_PRODUCTS_DIR;')
obj('sources', 'isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = (' + ','.join(key('build-' + f.name) for f in files) + '); runOnlyForDeploymentPostprocessing = 0;')
obj('frameworks', 'isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0;')
resources = [('TerminalAssets', 'folder'), ('Assets.xcassets', 'folder.assetcatalog'), ('PrivacyInfo.xcprivacy', 'text.xml')]
for name, kind in resources:
    obj(name, f'isa = PBXFileReference; lastKnownFileType = {kind}; path = {name}; sourceTree = "<group>";')
    obj('build-' + name, f'isa = PBXBuildFile; fileRef = {key(name)};')
obj('resources', 'isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; files = (' + ','.join(key('build-' + name) for name, _ in resources) + '); runOnlyForDeploymentPostprocessing = 0;')
obj('sourcegroup', 'isa = PBXGroup; children = (' + ','.join([key(name) for name, _ in resources]+[key(f.name) for f in files]) + '); path = AgentRemote; sourceTree = "<group>";')
obj('products', f'isa = PBXGroup; children = ({key("app")}); name = Products; sourceTree = "<group>";')
obj('main', f'isa = PBXGroup; children = ({key("sourcegroup")},{key("products")}); sourceTree = "<group>";')
for scope in ['project','target']:
    for config in ['Debug','Release']:
        settings = 'CLANG_ENABLE_MODULES = YES; SDKROOT = iphoneos; IPHONEOS_DEPLOYMENT_TARGET = 17.0; SWIFT_VERSION = 5.0; '
        if scope == 'target': settings += 'PRODUCT_NAME = "$(TARGET_NAME)"; PRODUCT_BUNDLE_IDENTIFIER = com.agentremote.personal; INFOPLIST_FILE = AgentRemote/Info.plist; TARGETED_DEVICE_FAMILY = "1,2"; CODE_SIGN_STYLE = Automatic; SWIFT_EMIT_LOC_STRINGS = YES; ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon; CURRENT_PROJECT_VERSION = 17; '
        settings += 'SWIFT_OPTIMIZATION_LEVEL = "-Onone"; DEBUG_INFORMATION_FORMAT = dwarf;' if config == 'Debug' else 'SWIFT_OPTIMIZATION_LEVEL = "-O"; DEBUG_INFORMATION_FORMAT = "dwarf-with-dsym";'
        obj(scope+config, f'isa = XCBuildConfiguration; buildSettings = {{ {settings} }}; name = {config};')
    obj(scope+'configs', f'isa = XCConfigurationList; buildConfigurations = ({key(scope+"Debug")},{key(scope+"Release")}); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release;')
obj('target', f'isa = PBXNativeTarget; buildConfigurationList = {key("targetconfigs")}; buildPhases = ({key("sources")},{key("frameworks")},{key("resources")}); buildRules = (); dependencies = (); name = AgentRemote; productName = AgentRemote; productReference = {key("app")}; productType = "com.apple.product-type.application";')
obj('project', f'isa = PBXProject; attributes = {{ LastUpgradeCheck = 2610; }}; buildConfigurationList = {key("projectconfigs")}; compatibilityVersion = "Xcode 14.0"; developmentRegion = en; knownRegions = (en,Base); mainGroup = {key("main")}; productRefGroup = {key("products")}; projectDirPath = ""; projectRoot = ""; targets = ({key("target")});')
(project/'project.pbxproj').write_text('// !$*UTF8*$!\n{ archiveVersion = 1; classes = {}; objectVersion = 56; objects = {\n' + '\n'.join(objects) + f'\n}}; rootObject = {key("project")}; }}\n')
print(project)
