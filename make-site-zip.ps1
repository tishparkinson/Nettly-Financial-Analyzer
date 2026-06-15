# Run in PowerShell from this folder (Right-click -> Run with PowerShell, or: .\make-site-zip.ps1)
# Creates quickexhale-site.zip next to this script with everything needed for Netlify + local preview.

$here = $PSScriptRoot
$staging = Join-Path $here "_quickexhale_pkg_staging"
$zipOut = Join-Path $here "quickexhale-site.zip"

$files = @(
    "index.html", "about.html", "privacy.html", "terms.html",
    "styles.css", "app.js", "config.js",
    "robots.txt", "sitemap.xml",
    "netlify.toml", "supabase.sql",
    "README.md", "LAUNCH-TODO.md", "FILES-INCLUDED.txt",
    ".env.example", ".gitignore",
    "make-site-zip.ps1"
)

if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Path $staging | Out-Null

foreach ($f in $files) {
    $p = Join-Path $here $f
    if (Test-Path $p) { Copy-Item $p -Destination $staging }
}

Copy-Item (Join-Path $here "netlify") -Destination (Join-Path $staging "netlify") -Recurse

if (Test-Path $zipOut) { Remove-Item $zipOut -Force }
Compress-Archive -Path $staging -DestinationPath $zipOut -Force
Remove-Item $staging -Recurse -Force

Write-Host "Done. ZIP path:"
Write-Host $zipOut
