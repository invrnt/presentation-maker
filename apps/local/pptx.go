package main

import (
	"archive/zip"
	"bytes"
	"database/sql"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const slideCX int64 = 12192000
const slideCY int64 = 6858000

type pptMedia struct {
	element                                          element
	source, poster, extension, mediaName, posterName string
	kind                                             string
}

func (a *app) exportProjectHandler(w http.ResponseWriter, r *http.Request, id string) {
	if !safeID.MatchString(id) {
		jsonError(w, 400, "Proyecto inválido.")
		return
	}
	row, err := a.db.project(id)
	if err == sql.ErrNoRows {
		jsonError(w, 404, "No encontramos ese proyecto.")
		return
	}
	if err != nil {
		jsonError(w, 500, "No se pudo abrir el proyecto.")
		return
	}
	var doc projectDocument
	if json.Unmarshal(row.Document, &doc) != nil {
		jsonError(w, 500, "El proyecto guardado está dañado.")
		return
	}
	missing := []string{}
	for _, s := range doc.Slides {
		for _, item := range s.Elements {
			if item.Type == "image" {
				if _, err := os.Stat(filepath.Join(a.root, "assets", filepath.Base(item.AssetID))); err != nil {
					missing = append(missing, "una imagen")
				}
			}
			if item.Type == "video" {
				media, err := a.db.media(item.YoutubeID)
				if err != nil || media.Status != "ready" {
					name := item.Title
					if name == "" {
						name = item.YoutubeID
					}
					missing = append(missing, name)
					continue
				}
				if _, err := os.Stat(media.Path); err != nil {
					missing = append(missing, item.Title)
				}
			}
		}
	}
	if len(missing) > 0 {
		jsonError(w, 409, "No se puede exportar todavía. Falta: "+strings.Join(missing, ", "))
		return
	}
	filename := safeFilename(doc.Title) + ".pptx"
	if filename == ".pptx" {
		filename = "Presentacion.pptx"
	}
	temporary := filepath.Join(a.root, "exports", filename+".tmp")
	target := filepath.Join(a.root, "exports", filename)
	_ = os.Remove(temporary)
	if err := a.writePPTX(temporary, doc); err != nil {
		_ = os.Remove(temporary)
		jsonError(w, 500, "No se pudo crear el PPTX: "+err.Error())
		return
	}
	if err := validateZip(temporary); err != nil {
		_ = os.Remove(temporary)
		jsonError(w, 500, "La presentación generada no pasó la validación.")
		return
	}
	_ = os.Remove(target)
	if err := os.Rename(temporary, target); err != nil {
		jsonError(w, 500, "No se pudo mover la presentación a la carpeta de exportaciones.")
		return
	}
	jsonResponse(w, 200, map[string]string{"url": "/api/exports/" + filename, "filename": filename})
}

func (a *app) writePPTX(target string, doc projectDocument) error {
	file, err := os.Create(target)
	if err != nil {
		return err
	}
	archive := zip.NewWriter(file)
	failed := false
	defer func() {
		if failed {
			_ = os.Remove(target)
		}
	}()
	write := func(name, content string) error { return zipText(archive, name, content) }
	base, err := zip.NewReader(bytes.NewReader(pptxTemplate), int64(len(pptxTemplate)))
	if err != nil {
		return fmt.Errorf("la plantilla PPTX no es válida: %w", err)
	}
	for _, entry := range base.File {
		if skipTemplateEntry(entry.Name) {
			continue
		}
		reader, openErr := entry.Open()
		if openErr != nil {
			return openErr
		}
		header := entry.FileHeader
		writer, createErr := archive.CreateHeader(&header)
		if createErr == nil {
			_, createErr = io.Copy(writer, reader)
		}
		reader.Close()
		if createErr != nil {
			return createErr
		}
	}
	if err = write("[Content_Types].xml", contentTypes(len(doc.Slides))); err != nil {
		return err
	}
	dynamic := map[string]string{
		"docProps/app.xml": appProps(len(doc.Slides)), "docProps/core.xml": coreProps(doc.Title),
		"ppt/presentation.xml": presentationXML(len(doc.Slides)), "ppt/_rels/presentation.xml.rels": presentationRels(len(doc.Slides)),
	}
	for name, value := range dynamic {
		if err = write(name, value); err != nil {
			return err
		}
	}
	mediaIndex := 0
	for slideIndex, s := range doc.Slides {
		items := make([]pptMedia, 0, len(s.Elements))
		for _, item := range s.Elements {
			switch item.Type {
			case "text":
				items = append(items, pptMedia{element: item, kind: "text"})
			case "image":
				mediaIndex++
				ext := strings.ToLower(filepath.Ext(item.AssetID))
				items = append(items, pptMedia{element: item, source: filepath.Join(a.root, "assets", filepath.Base(item.AssetID)), extension: ext, mediaName: fmt.Sprintf("image%d%s", mediaIndex, ext), kind: "image"})
			case "video":
				media, err := a.db.media(item.YoutubeID)
				if err != nil {
					return err
				}
				mediaIndex++
				poster := media.ThumbnailPath
				if poster == "" {
					poster = filepath.Join(a.root, "cache", "thumbnails", item.YoutubeID+".jpg")
					if err := exec.Command(a.bin("ffmpeg"), "-y", "-ss", "1", "-i", media.Path, "-frames:v", "1", "-q:v", "3", poster).Run(); err != nil {
						return fmt.Errorf("no se pudo crear la vista previa de %s", item.Title)
					}
				}
				items = append(items, pptMedia{element: item, source: media.Path, poster: poster, extension: ".mp4", mediaName: fmt.Sprintf("video%d.mp4", mediaIndex), posterName: fmt.Sprintf("poster%d.jpg", mediaIndex), kind: "video"})
			}
		}
		if err = write(fmt.Sprintf("ppt/slides/slide%d.xml", slideIndex+1), slideXML(items)); err != nil {
			return err
		}
		if err = write(fmt.Sprintf("ppt/slides/_rels/slide%d.xml.rels", slideIndex+1), slideRels(items)); err != nil {
			return err
		}
		for _, item := range items {
			if item.kind == "text" {
				continue
			} else if item.kind == "image" {
				if err = zipFile(archive, "ppt/media/"+item.mediaName, item.source, true); err != nil {
					return err
				}
			} else {
				if err = zipFile(archive, "ppt/media/"+item.posterName, item.poster, true); err != nil {
					return err
				}
				if err = zipFile(archive, "ppt/media/"+item.mediaName, item.source, false); err != nil {
					return err
				}
			}
		}
	}
	if err = archive.Close(); err != nil {
		failed = true
		file.Close()
		return err
	}
	if err = file.Close(); err != nil {
		failed = true
		return err
	}
	return nil
}

func skipTemplateEntry(name string) bool {
	if name == "[Content_Types].xml" || name == "docProps/app.xml" || name == "docProps/core.xml" || name == "ppt/presentation.xml" || name == "ppt/_rels/presentation.xml.rels" {
		return true
	}
	return strings.HasPrefix(name, "ppt/slides/") || strings.HasPrefix(name, "ppt/media/")
}

func zipText(archive *zip.Writer, name, content string) error {
	writer, err := archive.Create(name)
	if err != nil {
		return err
	}
	_, err = io.WriteString(writer, content)
	return err
}
func zipFile(archive *zip.Writer, name, source string, compress bool) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	info, err := input.Stat()
	if err != nil {
		return err
	}
	header, err := zip.FileInfoHeader(info)
	if err != nil {
		return err
	}
	header.Name = name
	if compress {
		header.Method = zip.Deflate
	} else {
		header.Method = zip.Store
	}
	writer, err := archive.CreateHeader(header)
	if err != nil {
		return err
	}
	_, err = io.Copy(writer, input)
	return err
}
func validateZip(filename string) error {
	archive, err := zip.OpenReader(filename)
	if err != nil {
		return err
	}
	defer archive.Close()
	required := map[string]bool{"[Content_Types].xml": false, "ppt/presentation.xml": false}
	for _, item := range archive.File {
		if _, ok := required[item.Name]; ok {
			required[item.Name] = true
		}
	}
	for name, found := range required {
		if !found {
			return fmt.Errorf("falta %s", name)
		}
	}
	return nil
}

func slideXML(items []pptMedia) string {
	var shapes strings.Builder
	shapeID := 2
	relationship := 1
	for _, media := range items {
		item := media.element
		x, y, cx, cy := coordinates(item)
		if item.Type == "text" {
			shapes.WriteString(textShape(shapeID, item, x, y, cx, cy))
			shapeID++
			continue
		}
		if media.kind == "image" {
			shapes.WriteString(imageShape(shapeID, item, x, y, cx, cy, relationship))
			relationship++
		} else {
			shapes.WriteString(videoShape(shapeID, item, x, y, cx, cy, relationship, relationship+1, relationship+2))
			relationship += 3
		}
		shapeID++
	}
	return xmlHeader + `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` + shapes.String() + `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
}
func coordinates(item element) (int64, int64, int64, int64) {
	return int64(item.X / 1920 * float64(slideCX)), int64(item.Y / 1080 * float64(slideCY)), int64(item.Width / 1920 * float64(slideCX)), int64(item.Height / 1080 * float64(slideCY))
}
func textShape(id int, item element, x, y, cx, cy int64) string {
	align := map[string]string{"left": "l", "center": "ctr", "right": "r"}[item.Align]
	if align == "" {
		align = "l"
	}
	font := item.FontFamily
	if font == "" {
		font = "Arial"
	}
	color := strings.TrimPrefix(item.Color, "#")
	if len(color) != 6 {
		color = "17211B"
	}
	weight := "0"
	if item.FontWeight >= 700 {
		weight = "1"
	}
	return fmt.Sprintf(`<p:sp><p:nvSpPr><p:cNvPr id="%d" name="Texto %d"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="%d" y="%d"/><a:ext cx="%d" cy="%d"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap="square" anchor="ctr"/><a:lstStyle/><a:p><a:pPr algn="%s"/><a:r><a:rPr lang="es-ES" sz="%d" b="%s"><a:solidFill><a:srgbClr val="%s"/></a:solidFill><a:latin typeface="%s"/></a:rPr><a:t>%s</a:t></a:r><a:endParaRPr lang="es-ES" sz="%d"/></a:p></p:txBody></p:sp>`, id, id, x, y, cx, cy, align, item.FontSize*100, weight, color, xmlEscape(font), xmlEscape(item.Text), item.FontSize*100)
}
func imageShape(id int, item element, x, y, cx, cy int64, rel int) string {
	return fmt.Sprintf(`<p:pic><p:nvPicPr><p:cNvPr id="%d" name="Imagen %d"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId%d"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="%d" y="%d"/><a:ext cx="%d" cy="%d"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`, id, id, rel, x, y, cx, cy)
}
func videoShape(id int, item element, x, y, cx, cy int64, posterRel, videoRel, mediaRel int) string {
	return fmt.Sprintf(`<p:pic><p:nvPicPr><p:cNvPr id="%d" name="Video %d"><a:hlinkClick r:id="" action="ppaction://media"/></p:cNvPr><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr><a:videoFile r:link="rId%d"/><p:extLst><p:ext uri="{DAA4B4D4-6D71-4841-9C94-3DE7FCFB9230}"><p14:media xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" r:embed="rId%d"/></p:ext></p:extLst></p:nvPr></p:nvPicPr><p:blipFill><a:blip r:embed="rId%d"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="%d" y="%d"/><a:ext cx="%d" cy="%d"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`, id, id, videoRel, mediaRel, posterRel, x, y, cx, cy)
}

func slideRels(items []pptMedia) string {
	var out strings.Builder
	out.WriteString(xmlHeader + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`)
	rel := 1
	for _, item := range items {
		if item.kind == "text" {
			continue
		} else if item.kind == "image" {
			fmt.Fprintf(&out, `<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/%s"/>`, rel, item.mediaName)
			rel++
		} else {
			fmt.Fprintf(&out, `<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/%s"/><Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/video" Target="../media/%s"/><Relationship Id="rId%d" Type="http://schemas.microsoft.com/office/2007/relationships/media" Target="../media/%s"/>`, rel, item.posterName, rel+1, item.mediaName, rel+2, item.mediaName)
			rel += 3
		}
	}
	fmt.Fprintf(&out, `<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`, rel)
	out.WriteString(`</Relationships>`)
	return out.String()
}

const xmlHeader = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`

func contentTypes(slides int) string {
	var overrides strings.Builder
	for i := 1; i <= slides; i++ {
		fmt.Fprintf(&overrides, `<Override PartName="/ppt/slides/slide%d.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`, i)
	}
	return xmlHeader + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpg" ContentType="image/jpeg"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="mp4" ContentType="video/mp4"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/><Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/><Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>` + overrides.String() + `</Types>`
}
func rootRels() string {
	return xmlHeader + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`
}
func presentationXML(slides int) string {
	var ids strings.Builder
	for i := 1; i <= slides; i++ {
		fmt.Fprintf(&ids, `<p:sldId id="%d" r:id="rId%d"/>`, 255+i, i+1)
	}
	return xmlHeader + `<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>` + ids.String() + `</p:sldIdLst><p:sldSz cx="12192000" cy="6858000" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle/></p:presentation>`
}
func presentationRels(slides int) string {
	var out strings.Builder
	out.WriteString(xmlHeader + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>`)
	for i := 1; i <= slides; i++ {
		fmt.Fprintf(&out, `<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide%d.xml"/>`, i+1, i)
	}
	offset := slides + 2
	fmt.Fprintf(&out, `<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/presProps" Target="presProps.xml"/><Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/viewProps" Target="viewProps.xml"/><Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/tableStyles" Target="tableStyles.xml"/><Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>`, offset, offset+1, offset+2, offset+3)
	out.WriteString(`</Relationships>`)
	return out.String()
}
func slideMaster() string {
	return xmlHeader + `<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/><p:sldLayoutIdLst><p:sldLayoutId id="1" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`
}
func slideMasterRels() string {
	return xmlHeader + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>`
}
func slideLayout() string {
	return xmlHeader + `<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1"><p:cSld name="En blanco"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`
}
func slideLayoutRels() string {
	return xmlHeader + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`
}
func themeXML() string {
	return xmlHeader + `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Presentation Maker"><a:themeElements><a:clrScheme name="Claro"><a:dk1><a:srgbClr val="17211B"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="31453A"/></a:dk2><a:lt2><a:srgbClr val="F4F1EA"/></a:lt2><a:accent1><a:srgbClr val="246F4E"/></a:accent1><a:accent2><a:srgbClr val="5E806B"/></a:accent2><a:accent3><a:srgbClr val="C9904A"/></a:accent3><a:accent4><a:srgbClr val="71839A"/></a:accent4><a:accent5><a:srgbClr val="956E75"/></a:accent5><a:accent6><a:srgbClr val="79745F"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`
}
func presProps() string {
	return xmlHeader + `<p:presentationPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`
}
func viewProps() string {
	return xmlHeader + `<p:viewPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:normalViewPr/><p:slideViewPr><p:cSldViewPr snapToGrid="1"/></p:slideViewPr><p:notesTextViewPr><p:cViewPr varScale="1"><p:scale sx="100" sy="100"/><p:origin x="0" y="0"/></p:cViewPr></p:notesTextViewPr><p:gridSpacing cx="72008" cy="72008"/></p:viewPr>`
}
func tableStyles() string {
	return xmlHeader + `<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`
}
func appProps(slides int) string {
	return fmt.Sprintf(xmlHeader+`<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Presentation Maker</Application><PresentationFormat>Presentación en pantalla (16:9)</PresentationFormat><Slides>%d</Slides><Company></Company><AppVersion>1.0</AppVersion></Properties>`, slides)
}
func coreProps(title string) string {
	now := time.Now().UTC().Format(time.RFC3339)
	return fmt.Sprintf(xmlHeader+`<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>%s</dc:title><dc:creator>Presentation Maker</dc:creator><cp:lastModifiedBy>Presentation Maker</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">%s</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">%s</dcterms:modified></cp:coreProperties>`, xmlEscape(title), now, now)
}
func xmlEscape(value string) string {
	var out strings.Builder
	_ = xml.EscapeText(&out, []byte(value))
	return out.String()
}

var unsafeFilename = regexp.MustCompile(`[<>:"/\\|?*\x00-\x1f]`)

func safeFilename(value string) string {
	value = strings.Trim(strings.TrimSpace(unsafeFilename.ReplaceAllString(value, "")), ".")
	runes := []rune(value)
	if len(runes) > 90 {
		value = string(runes[:90])
	}
	return value
}
