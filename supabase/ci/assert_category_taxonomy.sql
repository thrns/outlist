do $check$
begin
  if (select count(*) from public.categories) <> 11 then
    raise exception 'expected exactly 11 categories';
  end if;

  if (select count(distinct slug) from public.categories) <> 11 then
    raise exception 'category slugs are not unique';
  end if;
end;
$check$;
