"use client";
import {useRef,useState,type FormEvent} from "react";
import Link from "next/link";
import {toast} from "sonner";
import {useDirectory} from "@/context/directory-provider";
import {categories,languages,licenses} from "@/data/catalog";
import {Breadcrumb} from "@/components/layout/breadcrumb";
import {Glyph} from "@/components/project/glyph";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {Textarea} from "@/components/ui/textarea";
import {NativeSelect} from "@/components/ui/native-select";
type Field="name"|"github"|"description"|"category"|"language"|"license"|"website"|"tags";
type FormValues=Record<Field,string>;
const blank:FormValues={name:"",github:"",description:"",category:"",language:"",license:"",website:"",tags:""};
function validate(values:FormValues,repos:string[]):Partial<Record<Field,string>> {
  const errors:Partial<Record<Field,string>>={};
  if(values.name.trim().length<2)errors.name="Enter a project name of at least 2 characters.";
  const match=values.github.trim().match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/?(?:\?.*)?$/i);
  if(!match)errors.github="Enter a GitHub repository URL such as https://github.com/owner/repo.";
  else if(repos.some(repo=>repo.toLowerCase()===(match[1]+"/"+match[2]).toLowerCase()))errors.github="This repository is already in the directory or pending review.";
  const length=values.description.trim().length;
  if(length<20)errors.description="Describe the project in at least 20 characters.";
  else if(length>400)errors.description="Keep the description under 400 characters.";
  if(!categories.some(c=>c.id===values.category))errors.category="Choose a category.";
  if(!languages.includes(values.language))errors.language="Choose a primary language.";
  if(!licenses.includes(values.license))errors.license="Choose a license.";
  if(values.website.trim()){try{const url=new URL(values.website.trim());if(!["http:","https:"].includes(url.protocol))errors.website="Enter an HTTP or HTTPS website URL.";}catch{errors.website="Enter a valid website URL starting with https://.";}}
  return errors;
}
export function SubmissionPage(){
  const {projects,submissions,submit}=useDirectory();
  const [values,setValues]=useState<FormValues>(blank);
  const [errors,setErrors]=useState<Partial<Record<Field,string>>>({});
  const [submitted,setSubmitted]=useState(false);
  const formRef=useRef<HTMLFormElement>(null);
  function update(field:Field,value:string){setValues(s=>({...s,[field]:value}));if(errors[field])setErrors(s=>({...s,[field]:undefined}));}
  function onSubmit(e:FormEvent<HTMLFormElement>){e.preventDefault();
    const errs=validate(values,[...projects.map(p=>p.repo),...submissions.filter(p=>p.status!=="rejected").map(p=>p.repo)]);
    if(Object.keys(errs).length){setErrors(errs);const first=Object.keys(errs)[0] as Field;formRef.current?.querySelector<HTMLElement>(`[name="${first}"]`)?.focus();toast.error("Review the highlighted fields before submitting.");return;}
    const match=values.github.trim().match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)/i);
    if(!match)return;
    submit({name:values.name.trim(),repo:`${match[1]}/${match[2]}`,description:values.description.trim(),category:values.category,language:values.language,license:values.license,website:values.website.trim(),tags:values.tags.split(",").map(tag=>tag.trim()).filter(Boolean)});
    setSubmitted(true);toast.success("Submission added to the moderation queue");window.scrollTo({top:0,behavior:"smooth"});
  }
  function field(field:Field,label:string,placeholder:string,required=true,type="text"){
    return <div className="form-field" key={field}><label className="field-label" htmlFor={field}>{label} {required?<span className="muted">*</span>:<span className="muted fine">(optional)</span>}</label><Input id={field} name={field} type={type} value={values[field]} onChange={e=>update(field,e.target.value)} placeholder={placeholder} required={required} aria-invalid={Boolean(errors[field])} aria-describedby={`error-${field}`}/><div className="error" id={`error-${field}`} aria-live="polite">{errors[field]}</div></div>;
  }
  function select(field:Field,label:string,options:{value:string;label:string}[]){return <div className="form-field" key={field}><label className="field-label" htmlFor={field}>{label} <span className="muted">*</span></label><NativeSelect id={field} name={field} value={values[field]} onChange={e=>update(field,e.target.value)} required aria-invalid={Boolean(errors[field])} aria-describedby={`error-${field}`}><option value="">Select {label.toLowerCase()}</option>{options.map(opt=><option key={opt.value} value={opt.value}>{opt.label}</option>)}</NativeSelect><div className="error" id={`error-${field}`} aria-live="polite">{errors[field]}</div></div>}
  return <main className="container page"><Breadcrumb items={[{label:"Home",href:"/"},{label:"Submit a project"}]}/><div className="page-head" style={{marginTop:15}}><div><div className="eyebrow muted">Grow the directory</div><h1 className="page-title">Submit an open-source project</h1><p className="muted" style={{margin:0}}>Share a tool worth discovering. Submissions enter a local demo review queue.</p></div></div>
    <div className="form-layout"><div>{submitted?<div className="success-panel"><span className="category-icon" style={{margin:"auto",height:54,width:54}}><Glyph name="circlecheck" size="lg"/></span><h2>Project submitted for review</h2><p>We&apos;ve added your submission to the local moderation queue. Visit the admin demo to approve or reject it.</p><div className="flex justify-center flex-wrap gap-2"><Button onClick={()=>{setValues(blank);setErrors({});setSubmitted(false);}}>Submit another <Glyph name="plus"/></Button><Button asChild variant="outline"><Link href="/admin">Open admin queue <Glyph name="arrow"/></Link></Button></div></div>
    :<form className="form-card" ref={formRef} onSubmit={onSubmit} noValidate><div className="eyebrow muted" style={{marginBottom:19}}>Project information</div><div className="form-grid">
      {field("name","Project name","e.g. OpenProject")}{field("github","GitHub repository URL","https://github.com/owner/repository",true,"url")}
      <div className="form-field full"><label className="field-label" htmlFor="description">Short description <span className="muted">*</span></label><Textarea id="description" name="description" rows={4} minLength={20} maxLength={400} value={values.description} onChange={e=>update("description",e.target.value)} placeholder="What does your project do, and who is it for?" required aria-invalid={Boolean(errors.description)} aria-describedby="error-description"/><div className="form-help">20–400 characters. Describe the project without marketing claims.</div><div className="error" id="error-description" aria-live="polite">{errors.description}</div></div>
      {select("category","Category",categories.map(c=>({value:c.id,label:c.name})))}{select("language","Primary language",languages.map(v=>({value:v,label:v})))}{select("license","License",licenses.map(v=>({value:v,label:v})))}
      {field("website","Project website","https://project.example",false,"url")}{field("tags","Tags","self-hosted, documentation, api",false)}
      <div className="form-field full" style={{margin:0}}><div className="alert-inline" style={{margin:0}}><Glyph name="info"/> <span>This demo stores submissions in your browser only. No external review or publishing occurs.</span></div></div></div><div className="form-actions"><Button type="submit" size="lg">Submit for review <Glyph name="arrow"/></Button><span className="fine muted">Fields marked * are required</span></div></form>}</div>
    <aside className="guide-box"><h3>Submission guidelines</h3><ol><li>Share a public source repository.</li><li>Use the project&apos;s real name and description.</li><li>Provide the correct license and category.</li><li>Review the project in the admin demo.</li></ol><div className="line" style={{margin:"17px 0"}}/><div className="fine muted">Outlist is currently a discovery directory prototype. It does not host code, create accounts or manage community features.</div></aside></div></main>;
}
